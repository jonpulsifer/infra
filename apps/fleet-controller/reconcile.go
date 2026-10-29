package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// Reconciler makes Tinkerbell match NetBox. Every pass is idempotent: it
// reads the whole device list, applies each device's Hardware and Machine,
// starts the Workflows that desired_action asks for, finishes retirements,
// and prunes old Workflows. A pass that cannot read NetBox changes nothing.
type Reconciler struct {
	Config  Config
	NetBox  *NetBox
	Kube    *Kube
	Metrics *Metrics
	Now     func() time.Time

	mu       sync.Mutex
	reported map[string]bool
}

// Loop runs a pass every interval and shortly after each trigger. Triggers
// within the debounce window coalesce, and passes are at least minSpacing
// apart, so the controller's own NetBox writes, which ring the webhook, cost
// one quiet pass and never a storm.
func (r *Reconciler) Loop(ctx context.Context, trigger <-chan string) {
	const debounce = 2 * time.Second
	const minSpacing = 5 * time.Second
	ticker := time.NewTicker(r.Config.Interval)
	defer ticker.Stop()
	var last time.Time
	pass := func(why string) {
		if wait := minSpacing - time.Since(last); wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return
			}
		}
		last = time.Now()
		r.Metrics.Reconciles.Add(1)
		err := r.Reconcile(ctx)
		r.Metrics.Reconciled(time.Now(), err == nil)
		if err != nil {
			r.Metrics.ReconcileErrors.Add(1)
			log.Printf("reconcile (%s): %v", why, err)
		}
	}
	pass("start")
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pass("timer")
		case why := <-trigger:
			timer := time.NewTimer(debounce)
		drain:
			for {
				select {
				case <-trigger:
				case <-timer.C:
					break drain
				case <-ctx.Done():
					timer.Stop()
					return
				}
			}
			pass(why)
		}
	}
}

// Healthy says whether the last clean pass is recent.
func (r *Reconciler) Healthy(within time.Duration) (bool, string) {
	last := r.Metrics.LastOK()
	if last.IsZero() {
		return false, "no pass has succeeded yet"
	}
	if age := time.Since(last); age > within {
		return false, fmt.Sprintf("the last clean pass was %s ago", age.Round(time.Second))
	}
	return true, ""
}

// once returns true the first time a key is seen, so a condition the pass
// finds again and again gets one journal entry.
func (r *Reconciler) once(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reported == nil {
		r.reported = map[string]bool{}
	}
	if r.reported[key] {
		return false
	}
	r.reported[key] = true
	return true
}

// Reconcile is one pass.
func (r *Reconciler) Reconcile(ctx context.Context) error {
	devices, err := r.NetBox.Devices(ctx, r.Config.Site)
	if err != nil {
		return fmt.Errorf("NetBox: %w", err)
	}
	counts := map[string]int{}
	for _, d := range devices {
		counts[d.Status]++
	}
	r.Metrics.SetDevices(counts)

	var errs []error
	keep := map[string]bool{}
	for _, d := range devices {
		keep[d.Name] = true
		if err := r.device(ctx, d); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.Name, err))
		}
	}
	// A device NetBox no longer exports, offline or deleted, keeps no objects.
	// An empty list is left alone: it is a NetBox with no nodes, or a filter
	// gone wrong, and either way nothing to delete over.
	if len(devices) > 0 {
		for _, res := range []Resource{HardwareResource, MachineResource} {
			objs, err := r.Kube.List(ctx, res, ManagedLabel+"="+FieldManager)
			if err != nil {
				errs = append(errs, fmt.Errorf("list %s: %w", res.Plural, err))
				continue
			}
			for _, o := range objs {
				if !keep[o.Name()] {
					if err := r.Kube.Delete(ctx, res, o.Name()); err != nil {
						errs = append(errs, fmt.Errorf("delete %s %s: %w", res.Kind, o.Name(), err))
					}
				}
			}
		}
	}
	if err := r.prune(ctx); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

func (r *Reconciler) device(ctx context.Context, d Device) error {
	hardware := d.MAC != "" && d.Disk != ""
	if hardware {
		if err := r.Kube.Apply(ctx, HardwareResource, r.Config.Hardware(d)); err != nil {
			return fmt.Errorf("apply Hardware: %w", err)
		}
	}
	if d.BMCType != "none" && d.BMCAddress != "" {
		m, err := r.Config.Machine(d)
		if err != nil {
			return err
		}
		if err := r.Kube.Apply(ctx, MachineResource, m); err != nil {
			return fmt.Errorf("apply Machine: %w", err)
		}
	} else if err := r.Kube.Delete(ctx, MachineResource, d.Name); err != nil {
		return fmt.Errorf("delete Machine: %w", err)
	}

	if d.Status == "decommissioning" {
		return r.retire(ctx, d, hardware)
	}
	if _, ok := Actions[d.DesiredAction]; !ok {
		return nil
	}
	if !hardware {
		if r.once("no-hardware/" + d.Name + "/" + d.DesiredAction) {
			why := "fleet-controller: " + d.DesiredAction + " waits: the device needs a primary MAC on an interface and install_disk"
			if err := r.NetBox.Update(ctx, d, "", nil, "warning", why); err != nil {
				return err
			}
		}
		return nil
	}
	return r.start(ctx, d, d.DesiredAction, "staged")
}

// start creates the Workflow for an action and records it on the device.
func (r *Reconciler) start(ctx context.Context, d Device, action, status string) error {
	wf := r.Config.Workflow(d, action, r.Now())
	name := wf.Name()
	if err := r.Kube.Create(ctx, WorkflowResource, wf); err != nil {
		return fmt.Errorf("create Workflow %s: %w", name, err)
	}
	r.Metrics.WorkflowsCreated.Add(1)
	fields := map[string]any{"desired_action": "none", "last_workflow": name}
	if status == d.Status {
		status = ""
	}
	comment := fmt.Sprintf("fleet-controller: started Workflow %s (%s)", name, action)
	if err := r.NetBox.Update(ctx, d, status, fields, "info", comment); err != nil {
		return fmt.Errorf("record Workflow %s: %w", name, err)
	}
	Audit("fleet.workflow", r.Config.Site, d, name, action)
	return nil
}

// retire wipes a decommissioning device once and, when the wipe succeeds,
// deletes its objects and sets it offline. A failed wipe is journaled once
// and left for the owner: a new desired_action is not read in this status,
// so the owner sets status back to active, or offline by hand.
func (r *Reconciler) retire(ctx context.Context, d Device, hardware bool) error {
	if !strings.HasPrefix(d.LastWorkflow, "wipe-"+d.Name+"-") {
		if !hardware {
			if r.once("no-hardware/" + d.Name + "/wipe") {
				why := "fleet-controller: the retirement wipe waits: the device needs a primary MAC on an interface and install_disk"
				return r.NetBox.Update(ctx, d, "", nil, "warning", why)
			}
			return nil
		}
		return r.start(ctx, d, "wipe", "")
	}
	wf, err := r.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	if errors.Is(err, ErrNotFound) {
		// Pruned or lost before it finished: run the wipe again.
		return r.start(ctx, d, "wipe", "")
	}
	if err != nil {
		return fmt.Errorf("get Workflow %s: %w", d.LastWorkflow, err)
	}
	state := wf.State()
	switch {
	case Succeeded(state):
		for _, res := range []Resource{HardwareResource, MachineResource} {
			if err := r.Kube.Delete(ctx, res, d.Name); err != nil {
				return fmt.Errorf("delete %s: %w", res.Kind, err)
			}
		}
		comment := fmt.Sprintf("fleet-controller: Workflow %s wiped the disk; the device is offline and its Tinkerbell objects are gone", d.LastWorkflow)
		if err := r.NetBox.Update(ctx, d, "offline", nil, "success", comment); err != nil {
			return err
		}
		r.Metrics.Retired.Add(1)
		Audit("fleet.retire", r.Config.Site, d, d.LastWorkflow, "wiped")
	case Finished(state):
		if r.once("wipe-failed/" + d.LastWorkflow) {
			comment := fmt.Sprintf("fleet-controller: the retirement Workflow %s ended %s; the device stays decommissioning", d.LastWorkflow, state)
			if err := r.NetBox.Update(ctx, d, "", nil, "danger", comment); err != nil {
				return err
			}
			Audit("fleet.retire", r.Config.Site, d, d.LastWorkflow, strings.ToLower(state))
		}
	}
	return nil
}

// prune deletes the controller's Workflows older than the TTL.
func (r *Reconciler) prune(ctx context.Context) error {
	objs, err := r.Kube.List(ctx, WorkflowResource, ManagedLabel+"="+FieldManager)
	if err != nil {
		return fmt.Errorf("list workflows: %w", err)
	}
	cutoff := r.Now().Add(-r.Config.WorkflowTTL)
	var errs []error
	for _, o := range objs {
		created := o.Created()
		if created.IsZero() || !created.Before(cutoff) {
			continue
		}
		if err := r.Kube.Delete(ctx, WorkflowResource, o.Name()); err != nil {
			errs = append(errs, fmt.Errorf("prune %s: %w", o.Name(), err))
			continue
		}
		r.Metrics.WorkflowsPruned.Add(1)
	}
	return errors.Join(errs...)
}
