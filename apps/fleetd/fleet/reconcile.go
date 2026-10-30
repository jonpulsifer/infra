package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"
)

// Reconciler makes Tinkerbell match NetBox. Every pass is idempotent: it
// reads the whole device list, applies each device's Hardware and Machine,
// starts the Workflows that desired_action asks for, finishes retirements,
// and prunes old Workflows. A pass that cannot read NetBox changes nothing.
type Reconciler struct {
	Config Config
	NetBox *NetBox
	Kube   *Kube
	// Cluster cordons a quarantined node, or is nil without credentials.
	Cluster *Cluster
	// Installer renders an admitted device's config and serves it, or is
	// nil without a renderer.
	Installer *Installer
	Metrics   *Metrics
	Now       func() time.Time

	// pass keeps a reconcile pass and an Admit apart, so one Workflow starts
	// for a device; an Admit gives up waiting when its context ends.
	pass     chan struct{}
	passOnce sync.Once
	mu       sync.Mutex
	reported map[string]bool
}

// Loop runs a pass every interval and shortly after each trigger. Triggers
// within the debounce window coalesce, and passes are at least minSpacing
// apart, so fleetd's own NetBox writes, which ring the webhook, cost
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

// journalOnce adds a journal entry the first time a key is seen, so a
// condition the pass finds again and again is written once. The key is
// marked only after the write succeeds.
func (r *Reconciler) journalOnce(ctx context.Context, key string, d Device, kind, comment string) error {
	r.mu.Lock()
	seen := r.reported[key]
	r.mu.Unlock()
	if seen {
		return nil
	}
	if err := r.NetBox.Update(ctx, d, "", nil, kind, comment); err != nil {
		return err
	}
	r.mu.Lock()
	if r.reported == nil {
		r.reported = map[string]bool{}
	}
	r.reported[key] = true
	r.mu.Unlock()
	return nil
}

// lock takes the pass, or gives up when ctx ends.
func (r *Reconciler) lock(ctx context.Context) error {
	r.passOnce.Do(func() { r.pass = make(chan struct{}, 1) })
	select {
	case r.pass <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *Reconciler) unlock() { <-r.pass }

// Reconcile is one pass. The installer's expiries and release retries run
// even when NetBox's device list fails.
func (r *Reconciler) Reconcile(ctx context.Context) error {
	if err := r.lock(ctx); err != nil {
		return err
	}
	defer r.unlock()
	if r.Installer != nil {
		defer r.Installer.Tick(ctx)
	}
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
	pass := newPassCache()
	for _, d := range devices {
		keep[d.Name] = true
		if err := r.cordonQuarantined(ctx, d); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.Name, err))
		}
		// Only the verifier writes a MAC it proved, so an attested device
		// without one waits.
		if d.MAC == "" && d.Installing() {
			why := "fleetd: the device is attested and has no MAC in NetBox; it provisions once the verifier writes the MAC it proved"
			if err := r.journalOnce(ctx, fmt.Sprintf("no-mac/%d", d.ID), d, "warning", why); err != nil {
				errs = append(errs, fmt.Errorf("%s: %w", d.Name, err))
			}
		}
		if err := r.device(ctx, d); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.Name, err))
		}
		if err := r.fillPort(ctx, d, pass); err != nil {
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

// deleteManaged deletes an object by name only when fleetd made it.
func (r *Reconciler) deleteManaged(ctx context.Context, res Resource, name string) error {
	o, err := r.Kube.Get(ctx, res, name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if o.Labels()[ManagedLabel] != FieldManager {
		log.Printf("%s %s is not fleetd's; left alone", res.Kind, name)
		return nil
	}
	return r.Kube.Delete(ctx, res, name)
}

// nodeWorkflows lists fleetd's Workflows for one device, newest first.
func (r *Reconciler) nodeWorkflows(ctx context.Context, d Device) ([]Object, error) {
	objs, err := r.Kube.List(ctx, WorkflowResource, ManagedLabel+"="+FieldManager+","+NodeLabel+"="+d.Name)
	if err != nil {
		return nil, fmt.Errorf("list Workflows: %w", err)
	}
	sortByCreatedDesc(objs)
	return objs, nil
}

// applyHardware applies the device's Hardware with its netboot flags.
func (r *Reconciler) applyHardware(ctx context.Context, d Device, netboot bool) error {
	if err := r.Kube.Apply(ctx, HardwareResource, r.Config.Hardware(d, netboot)); err != nil {
		return fmt.Errorf("apply Hardware: %w", err)
	}
	return nil
}

func (r *Reconciler) device(ctx context.Context, d Device) error {
	workflows, err := r.nodeWorkflows(ctx, d)
	if err != nil {
		return err
	}
	// The owner took the device out of decommissioning: a retirement that has
	// not finished is abandoned before it powers the node off.
	if d.Status != "decommissioning" {
		var kept []Object
		for _, wf := range workflows {
			if wf.Labels()[ActionLabel] == ActionRetire && !Finished(wf.State()) {
				if err := r.Kube.Delete(ctx, WorkflowResource, wf.Name()); err != nil {
					return fmt.Errorf("abandon %s: %w", wf.Name(), err)
				}
				Audit("fleet.workflow", r.Config.Site, d, wf.Name(), "abandoned: the device left decommissioning")
				continue
			}
			kept = append(kept, wf)
		}
		workflows = kept
	}
	hardware := d.MAC != "" && d.Disk != ""
	if hardware {
		if err := r.applyHardware(ctx, d, Unfinished(workflows)); err != nil {
			return err
		}
	}
	if d.HasBMC() {
		m, err := r.Config.Machine(d)
		if err != nil {
			return err
		}
		if err := r.Kube.Apply(ctx, MachineResource, m); err != nil {
			return fmt.Errorf("apply Machine: %w", err)
		}
	} else if err := r.deleteManaged(ctx, MachineResource, d.Name); err != nil {
		return fmt.Errorf("delete Machine: %w", err)
	}

	if d.Status == "decommissioning" {
		return r.retire(ctx, d, hardware, workflows)
	}
	if _, ok := Actions[d.DesiredAction]; !ok || d.DesiredAction == ActionRetire {
		return nil
	}
	// The control plane the Talos root bootstraps etcd on is never wiped:
	// a reinstall destroys etcd, and planned would take the cluster's only
	// control plane out of the root.
	if Actions[d.DesiredAction].Wipe && r.Config.Bootstrap != "" && d.Address == r.Config.Bootstrap {
		why := fmt.Sprintf("fleetd: %s refused: %s is the control plane the Talos root bootstraps etcd on, and a wipe destroys etcd; desired_action stays %s", d.DesiredAction, d.Address, d.DesiredAction)
		return r.journalOnce(ctx, "bootstrap/"+d.Name+"/"+d.DesiredAction, d, "warning", why)
	}
	if !hardware {
		why := "fleetd: " + d.DesiredAction + " waits: the device needs a primary MAC on an interface and install_disk"
		return r.journalOnce(ctx, "no-hardware/"+d.Name+"/"+d.DesiredAction, d, "warning", why)
	}
	_, err = r.start(ctx, d, d.DesiredAction, workflows, false)
	return err
}

// start makes sure one Workflow runs for the device and that NetBox names it,
// and returns its name. A run that is still going is adopted, never
// doubled: a second netboot Workflow would power-cycle the node mid-wipe.
// The device's finished Workflows are deleted first, because Tinkerbell's
// server may answer the agent with the first finished Workflow it finds for
// its ID. A new run's Hardware allows netboot before the Workflow exists, so
// Smee answers the firmware as soon as Rufio power-cycles it; a create that
// fails leaves the flags on until the next pass turns them off. With hookos,
// the machine already waits in HookOS, so Rufio stays out of the run.
func (r *Reconciler) start(ctx context.Context, d Device, action string, workflows []Object, hookos bool) (string, error) {
	var name, running string
	manual := false
	for _, wf := range workflows {
		if Finished(wf.State()) {
			if err := r.Kube.Delete(ctx, WorkflowResource, wf.Name()); err != nil {
				return "", fmt.Errorf("delete finished %s: %w", wf.Name(), err)
			}
			continue
		}
		if running == "" {
			running = wf.Name()
		}
	}
	if running != "" {
		name = running
	} else {
		wf := r.Config.Workflow(d, action, r.Now(), hookos)
		name = wf.Name()
		if err := r.applyHardware(ctx, d, true); err != nil {
			return "", err
		}
		if err := r.Kube.Create(ctx, WorkflowResource, wf); err != nil {
			return "", fmt.Errorf("create Workflow %s: %w", name, err)
		}
		r.Metrics.WorkflowsCreated.Add(1)
		manual = hookos || d.ManualBoot()
	}
	status := NextStatus(action, d.Status)
	if d.DesiredAction == "none" && d.LastWorkflow == name && status == "" {
		return name, nil
	}
	fields := map[string]any{"desired_action": "none", "last_workflow": name}
	comment := fmt.Sprintf("fleetd: started Workflow %s (%s)", name, action)
	switch {
	case manual && hookos:
		comment += "; the machine attested from HookOS, where it waits, and takes it"
	case manual:
		comment += "; no BMC drives this run: power the machine on by hand, and it PXE-boots"
	}
	if running != "" {
		comment = fmt.Sprintf("fleetd: Workflow %s is still running; %s waits for it", name, action)
	}
	if err := r.NetBox.Update(ctx, d, status, fields, "info", comment); err != nil {
		return "", fmt.Errorf("record Workflow %s: %w", name, err)
	}
	Audit("fleet.workflow", r.Config.Site, d, name, action)
	return name, nil
}

// retire runs one retire Workflow for a decommissioning device and, when the
// Workflow named in last_workflow succeeds, deletes the device's objects and
// sets it offline. A failed retirement is journaled once and left for the
// owner, who moves the status on by hand.
func (r *Reconciler) retire(ctx context.Context, d Device, hardware bool, workflows []Object) error {
	if !isRetireWorkflow(d.LastWorkflow, d.Name) {
		if !hardware {
			why := "fleetd: the retirement waits: the device needs a primary MAC on an interface and install_disk"
			return r.journalOnce(ctx, "no-hardware/"+d.Name+"/"+ActionRetire, d, "warning", why)
		}
		_, err := r.start(ctx, d, ActionRetire, workflows, false)
		return err
	}
	wf, err := r.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	if errors.Is(err, ErrNotFound) {
		// Pruned or lost before it finished: run the retirement again.
		_, err := r.start(ctx, d, ActionRetire, workflows, false)
		return err
	}
	if err != nil {
		return fmt.Errorf("get Workflow %s: %w", d.LastWorkflow, err)
	}
	state := wf.State()
	switch {
	case Succeeded(state):
		for _, res := range []Resource{HardwareResource, MachineResource} {
			if err := r.deleteManaged(ctx, res, d.Name); err != nil {
				return fmt.Errorf("delete %s: %w", res.Kind, err)
			}
		}
		comment := fmt.Sprintf("fleetd: Workflow %s wiped the disk and powered the node off; the device is offline and its Tinkerbell objects are gone", d.LastWorkflow)
		if err := r.NetBox.Update(ctx, d, "offline", nil, "success", comment); err != nil {
			return err
		}
		r.Metrics.Retired.Add(1)
		Audit("fleet.retire", r.Config.Site, d, d.LastWorkflow, "wiped")
	case Finished(state):
		comment := fmt.Sprintf("fleetd: the retirement Workflow %s ended %s; the device stays decommissioning", d.LastWorkflow, state)
		if err := r.journalOnce(ctx, "retire-failed/"+d.LastWorkflow, d, "danger", comment); err != nil {
			return err
		}
	}
	return nil
}

// prune deletes fleetd's Workflows older than the TTL.
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
