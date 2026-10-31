package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
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
	// Links keeps the TFTP netboot-not-allowed links of the devices' MACs,
	// or is nil without a directory.
	Links *TFTPLinks
	// SpireNodesFile is where each pass writes the nodes SPIRE registers,
	// or empty to write none.
	SpireNodesFile string
	Now            func() time.Time

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
		if r.Installer != nil {
			if err := r.Installer.Withdraw(ctx, d); err != nil {
				errs = append(errs, fmt.Errorf("%s: withdraw its config: %w", d.Name, err))
			}
		}
		if err := r.device(ctx, d); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.Name, err))
		}
		if err := r.checkPort(ctx, d); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", d.Name, err))
		}
	}
	// A device NetBox no longer exports, offline or deleted, keeps no objects.
	// An empty list is left alone: it is a NetBox with no nodes, or a filter
	// gone wrong, and either way nothing to delete over.
	if len(devices) > 0 {
		if r.Installer != nil {
			r.Installer.WithdrawGone(devices)
		}
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
	if err := r.syncLinks(devices); err != nil {
		errs = append(errs, err)
	}
	if r.SpireNodesFile != "" && len(devices) > 0 {
		if err := writeSpireNodes(r.SpireNodesFile, SpireNodesOf(devices)); err != nil {
			errs = append(errs, fmt.Errorf("SPIRE nodes: %w", err))
		}
	}
	if err := r.prune(ctx); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// syncLinks leaves the links alone for an empty device list, as the
// Hardware cleanup does.
func (r *Reconciler) syncLinks(devices []Device) error {
	if r.Links == nil || len(devices) == 0 {
		return nil
	}
	var macs []string
	for _, d := range devices {
		if d.MAC != "" {
			macs = append(macs, d.MAC)
		}
	}
	return r.Links.Sync(macs)
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
				ended, err := r.abandon(ctx, d, wf)
				if err != nil {
					return err
				}
				if ended {
					continue
				}
			}
			kept = append(kept, wf)
		}
		workflows = kept
	}
	workflows, err = r.nudgeOverdue(ctx, d, workflows)
	if err != nil {
		return err
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
	if why := d.Unidentified(d.DesiredAction); why != "" {
		return r.journalOnce(ctx, "unidentified/"+d.Name+"/"+d.DesiredAction, d, "warning", "fleetd: "+d.DesiredAction+" waits: "+why)
	}
	_, err = r.start(ctx, d, d.DesiredAction, workflows, false)
	return err
}

// nudgeOverdue ends each unfinished Workflow that is more than one pass past
// its global timeout, and returns the Workflows it leaves. Tinkerbell's
// controller checks the timeout only when it reconciles a Workflow, and a
// silent agent writes nothing, so the Workflow stays RUNNING, keeps netboot on
// and takes every new request. For a Workflow with a deadline, an annotation
// is the write that makes the controller reconcile and set TIMEOUT.
//
// The controller sets the deadline only once the first action reports a start
// time, which tink-agent sends only with that action's result. A run cut off
// before then has no deadline, so the controller never ends it, and the next
// netboot resumes it and wipes the disk. fleetd deletes such a Workflow once
// its creation plus its global timeout is more than a pass past: a deleted
// Workflow is no order to wipe, and Admit renders no code for it. The
// retirement of a decommissioning device is left alone: decommissioning asks
// for it again at once, and the owner ends it by moving the device out of
// decommissioning.
func (r *Reconciler) nudgeOverdue(ctx context.Context, d Device, workflows []Object) ([]Object, error) {
	now := r.Now()
	var kept []Object
	for _, wf := range workflows {
		if Finished(wf.State()) {
			kept = append(kept, wf)
			if err := r.reportEnded(ctx, d, wf); err != nil {
				return nil, err
			}
			continue
		}
		if stop, ok := wf.GlobalExecutionStop(); ok {
			kept = append(kept, wf)
			// One annotation is the write that makes the controller act; a
			// write every pass would only change the run under every pass's
			// other writes.
			if _, done := wf.Annotations()[OverdueAnnotation]; !done && now.Sub(stop) > r.Config.Interval {
				if err := r.annotateOverdue(ctx, d, wf, stop, now); err != nil {
					return nil, err
				}
			}
			continue
		}
		ended, err := r.endWithoutDeadline(ctx, d, wf, now)
		if err != nil {
			return nil, err
		}
		if !ended {
			kept = append(kept, wf)
		}
	}
	return kept, nil
}

// reportEnded journals a provision, wipe or retirement Workflow that ended
// FAILED or TIMEOUT, and marks the Workflow with EndedJournaledAnnotation once
// the journal write succeeds, so a restart does not journal it again. A crash
// between the two journals it twice at most. The Workflow's own message says
// only that the action completed, and the reason is on the machine's console
// and in spore's tinkerbell journal. A Workflow that ended at its boot job ran
// no action, and the reason is the BMC's answer in the Rufio Job.
func (r *Reconciler) reportEnded(ctx context.Context, d Device, wf Object) error {
	state := strings.TrimPrefix(wf.State(), "STATE_")
	if state != "FAILED" && state != "TIMEOUT" {
		return nil
	}
	if _, done := wf.Annotations()[EndedJournaledAnnotation]; done {
		return nil
	}
	boot, atBoot, err := r.bootJobFailure(ctx, wf)
	if err != nil {
		return err
	}
	retire := wf.Labels()[ActionLabel] == ActionRetire
	kind := "warning"
	if retire {
		kind = "danger"
	}
	var why, at string
	if atBoot {
		at = "its BMC job"
		why = fmt.Sprintf("fleetd: Workflow %s ended %s before any action ran: %s. Rufio did not network-boot the machine, so the run did nothing; the conditions of the Machine %s say whether its BMC answers: kubectl -n tinkerbell get machine %s -o yaml on spore", wf.Name(), state, boot, d.Name, d.Name)
		if !retire {
			why += ". Fix the BMC, then set desired_action to run it again"
		} else {
			if old := wf.Annotations()[SupersedesAnnotation]; old != "" {
				why += fmt.Sprintf(". The BMC had powered the machine off before fleetd deleted Workflow %s, which this retirement superseded, so %s stopped there, and the disk holds what it wrote until then", old, old)
			}
			why += fmt.Sprintf(". The retirement did not start: the disk is not wiped, so the node still holds its data and its identity, and the device stays decommissioning. fleetd starts the retirement again at %s (attempt %d); fix the BMC", timestamp(retryAt(wf)), attempt(wf)+1)
		}
	} else {
		action, actionState, message := wf.FailedAction()
		if action == "" {
			action, actionState = wf.CurrentAction(), state
		}
		at = action
		detail := fmt.Sprintf("action %q ended %s", action, actionState)
		if message != "" {
			detail += fmt.Sprintf(" with the message %q", message)
		}
		if retire {
			why = fmt.Sprintf("fleetd: the retirement Workflow %s ended %s; %s. The retirement did not complete: the disk may not be wiped, so the node may still hold its data and its identity, and the device stays decommissioning", wf.Name(), state, detail)
		} else {
			why = fmt.Sprintf("fleetd: Workflow %s ended %s; %s. Set desired_action to run it again", wf.Name(), state, detail)
		}
		why += fmt.Sprintf(". The reason is in the machine's console output, which spore's tinkerbell journal holds: journalctl -u tinkerbell | grep %s", d.Address)
	}
	if err := r.journalOnce(ctx, "ended/"+wf.Name(), d, kind, why); err != nil {
		return err
	}
	Audit("fleet.workflow", r.Config.Site, d, wf.Name(), "ended "+state+" at "+at)
	err = r.Kube.Annotate(ctx, WorkflowResource, wf.Name(), map[string]string{EndedJournaledAnnotation: r.Now().UTC().Format(time.RFC3339)})
	if err != nil && !errors.Is(err, ErrNotFound) {
		return fmt.Errorf("annotate ended %s: %w", wf.Name(), err)
	}
	return nil
}

func (r *Reconciler) annotateOverdue(ctx context.Context, d Device, wf Object, stop, now time.Time) error {
	err := r.Kube.Annotate(ctx, WorkflowResource, wf.Name(), map[string]string{OverdueAnnotation: now.UTC().Format(time.RFC3339)})
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("annotate overdue %s: %w", wf.Name(), err)
	}
	action := wf.CurrentAction()
	why := fmt.Sprintf("fleetd: Workflow %s passed its global timeout at %s while %q was current, and fleetd asked Tinkerbell to end it", wf.Name(), stop.UTC().Format(time.RFC3339), action)
	if action == "reboot" {
		why += "; the install and next-boot reported success and the reboot's report was lost, so the disk holds the install"
	}
	return r.journalOnce(ctx, "overdue/"+wf.Name(), d, "warning", why)
}

// endWithoutDeadline deletes a Workflow that has no deadline once its
// creation plus its global timeout is more than a pass past, and says whether
// it did. The delete holds only while the Workflow is as it was listed, so a
// first report that lands in between keeps the run.
func (r *Reconciler) endWithoutDeadline(ctx context.Context, d Device, wf Object, now time.Time) (bool, error) {
	created := wf.Created()
	if created.IsZero() || (wf.Labels()[ActionLabel] == ActionRetire && d.Status == "decommissioning") {
		return false, nil
	}
	timeout, ok := wf.GlobalTimeout()
	if !ok {
		timeout = TemplateGlobalTimeout
	}
	if now.Sub(created.Add(timeout)) <= r.Config.Interval {
		return false, nil
	}
	err := r.Kube.DeleteUnchanged(ctx, WorkflowResource, wf.Name(), wf.ResourceVersion())
	if errors.Is(err, ErrConflict) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("end %s: %w", wf.Name(), err)
	}
	Audit("fleet.workflow", r.Config.Site, d, wf.Name(), "ended: no first report within its global timeout")
	why := fmt.Sprintf("fleetd: Workflow %s never reported its first action within its global timeout of %s from its creation at %s, so Tinkerbell set it no deadline, and fleetd deleted it. A power loss, a machine that never reached HookOS, or an agent that died before wipe-disk reported stops a run there. The disk may be partly wiped or may still hold the old install, and no later boot resumes the run; set desired_action to run it again", wf.Name(), timeout, created.UTC().Format(time.RFC3339))
	return true, r.journalOnce(ctx, "overdue/"+wf.Name(), d, "warning", why)
}

// start makes sure one Workflow runs for the device and that NetBox names it,
// and returns its name. A run that is still going is adopted, never
// doubled: a second netboot Workflow would power-cycle the node mid-wipe.
// The Workflow is the request's record: a run this request started, whose
// NetBox write failed, is adopted finished or not and recorded again, never
// run twice. The device's finished Workflows are deleted before a create,
// because Tinkerbell's server may answer the agent with the first finished
// Workflow it finds for its ID. A new run's Hardware allows netboot before the
// Workflow exists, so Smee answers the firmware as soon as Rufio power-cycles
// it; a create that fails leaves the flags on until the next pass turns them
// off. With hookos, the machine already waits in HookOS, so Rufio stays out
// of the run.
func (r *Reconciler) start(ctx context.Context, d Device, action string, workflows []Object, hookos bool) (string, error) {
	running := firstUnfinished(workflows)
	if running == nil && len(workflows) > 0 && unrecorded(d, action, workflows[0]) {
		return r.adopt(ctx, d, action, workflows[0])
	}
	if err := r.deleteFinished(ctx, workflows); err != nil {
		return "", err
	}
	if running != nil {
		return r.adopt(ctx, d, action, running)
	}
	name, err := r.create(ctx, d, action, hookos, nil)
	if err != nil {
		return "", err
	}
	comment := fmt.Sprintf("fleetd: started Workflow %s (%s)", name, action)
	switch {
	case hookos:
		comment += "; the machine attested from HookOS, where it waits, and takes it"
	case d.ManualBoot():
		comment += "; no BMC drives this run: power the machine on by hand, and it PXE-boots"
	}
	return r.record(ctx, d, action, name, NextStatus(action, d.Status), comment)
}

func firstUnfinished(workflows []Object) Object {
	for _, wf := range workflows {
		if !Finished(wf.State()) {
			return wf
		}
	}
	return nil
}

func (r *Reconciler) deleteFinished(ctx context.Context, workflows []Object) error {
	for _, wf := range workflows {
		if Finished(wf.State()) {
			if err := r.Kube.Delete(ctx, WorkflowResource, wf.Name()); err != nil {
				return fmt.Errorf("delete finished %s: %w", wf.Name(), err)
			}
		}
	}
	return nil
}

// create makes a new run of the action, with the Hardware's netboot on first,
// and the annotations.
func (r *Reconciler) create(ctx context.Context, d Device, action string, hookos bool, annotations map[string]string) (string, error) {
	wf, err := r.Config.Workflow(d, action, r.Now(), hookos)
	if err == nil && len(annotations) > 0 {
		a := map[string]any{}
		for k, v := range annotations {
			a[k] = v
		}
		wf.metadata()["annotations"] = a
	}
	if err != nil {
		Audit("fleet.workflow", r.Config.Site, d, d.LastWorkflow, "refused: "+err.Error())
		if jerr := r.journalOnce(ctx, "no-class/"+d.Name+"/"+d.Class, d, "warning", "fleetd: "+action+" refused: "+err.Error()); jerr != nil {
			return "", jerr
		}
		return "", err
	}
	if err := r.applyHardware(ctx, d, true); err != nil {
		return "", err
	}
	if err := r.Kube.Create(ctx, WorkflowResource, wf); err != nil {
		return "", fmt.Errorf("create Workflow %s: %w", wf.Name(), err)
	}
	r.Metrics.WorkflowsCreated.Add(1)
	return wf.Name(), nil
}

// unrecorded says whether wf, the device's newest Workflow, is a run of the
// action that NetBox does not name, which fleetd created for this request
// and could not record. fleetd names every run it starts in last_workflow in
// the same write that clears desired_action, so while that write fails the
// request stays set, and the newest run of its action is the request's run.
func unrecorded(d Device, action string, wf Object) bool {
	return wf.Labels()[ActionLabel] == action && wf.Name() != d.LastWorkflow
}

// adopt names an existing run in NetBox instead of starting one. A run of the
// action is the request's run, and the request is consumed. A run of another
// action leaves the request set and NetBox unwritten, so the first pass after
// the run ends starts it. The status moves only while the run goes: a run
// that has ended already did its work.
func (r *Reconciler) adopt(ctx context.Context, d Device, action string, wf Object) (string, error) {
	name, its := wf.Name(), wf.Labels()[ActionLabel]
	if its != action {
		if d.DesiredAction != action {
			return name, nil
		}
		why := fmt.Sprintf("fleetd: %s waits: Workflow %s (%s) is still running; it starts when %s ends", action, name, its, name)
		return name, r.journalOnce(ctx, "waits/"+name+"/"+action, d, "info", why)
	}
	status := ""
	if !Finished(wf.State()) {
		status = NextStatus(action, d.Status)
	}
	if d.DesiredAction == "none" && d.LastWorkflow == name && status == "" {
		return name, nil
	}
	comment := fmt.Sprintf("fleetd: Workflow %s (%s) is already running; the request is that run", name, action)
	if unrecorded(d, action, wf) {
		comment = fmt.Sprintf("fleetd: started Workflow %s (%s); its record was late, and it is %s", name, action, stateWord(wf))
	}
	return r.record(ctx, d, action, name, status, comment)
}

// record writes a run to NetBox: last_workflow the run, the status the action
// moves the device to, and desired_action back to none. NetBox 4.5 takes no
// precondition on a PATCH, so fleetd reads the device again just before it
// and clears desired_action only while it still holds the request the pass
// read; a request the owner set since stays, and waits for the run.
func (r *Reconciler) record(ctx context.Context, d Device, action, name, status, comment string) (string, error) {
	now, err := r.NetBox.ByID(ctx, r.Config.Site, d.ID)
	if err != nil {
		return "", fmt.Errorf("record Workflow %s: read %s again: %w", name, d.Name, err)
	}
	fields := map[string]any{"last_workflow": name}
	switch now.DesiredAction {
	case d.DesiredAction:
		fields["desired_action"] = "none"
	case "none", "":
	default:
		comment += fmt.Sprintf("; desired_action changed to %s while fleetd started it, so it stays set and waits for %s", now.DesiredAction, name)
	}
	if err := r.NetBox.Update(ctx, d, status, fields, "info", comment); err != nil {
		return "", fmt.Errorf("record Workflow %s: %w", name, err)
	}
	Audit("fleet.workflow", r.Config.Site, d, name, action)
	return name, nil
}

// stateWord is a Workflow's state for the journal.
func stateWord(wf Object) string {
	if s := strings.TrimPrefix(wf.State(), "STATE_"); s != "" {
		return s
	}
	return "not yet picked up by Tinkerbell"
}

// retire runs one retire Workflow for a decommissioning device and, when the
// Workflow named in last_workflow succeeds, deletes the device's objects and
// sets it offline. A retirement that failed at its BMC job ran nothing, and
// starts again after a backoff (retryRetire). One that failed at an action is
// journaled once and left for the owner, who moves the status on by hand.
func (r *Reconciler) retire(ctx context.Context, d Device, hardware bool, workflows []Object) error {
	if !isRetireWorkflow(d.LastWorkflow, d.Name) {
		if !hardware {
			why := "fleetd: the retirement waits: the device needs a primary MAC on an interface and install_disk"
			return r.journalOnce(ctx, "no-hardware/"+d.Name+"/"+ActionRetire, d, "warning", why)
		}
		if why := d.Unidentified(ActionRetire); why != "" {
			return r.journalOnce(ctx, "unidentified/"+d.Name+"/"+ActionRetire, d, "warning", "fleetd: the retirement waits: "+why)
		}
		return r.startRetire(ctx, d, workflows)
	}
	wf, err := r.Kube.Get(ctx, WorkflowResource, d.LastWorkflow)
	if errors.Is(err, ErrNotFound) {
		// Pruned or lost before it finished: run the retirement again.
		return r.startRetire(ctx, d, workflows)
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
		return r.retryRetire(ctx, d, wf, workflows)
	}
	return nil
}

// retryRetire starts the retirement again once wf, the last one, ended at its
// BMC job and retryAt has passed. Such a run did nothing, so another is safe,
// and the wait doubles with each attempt, so a BMC that stays broken costs one
// Rufio Job per wait. The new run counts the attempt, and start's rules hold:
// the failed run is deleted first, and an unfinished run is never doubled.
func (r *Reconciler) retryRetire(ctx context.Context, d Device, wf Object, workflows []Object) error {
	_, atBoot, err := r.bootJobFailure(ctx, wf)
	if err != nil || !atBoot || r.Now().Before(retryAt(wf)) {
		return err
	}
	if firstUnfinished(workflows) != nil {
		return r.startRetire(ctx, d, workflows)
	}
	if err := r.deleteFinished(ctx, workflows); err != nil {
		return err
	}
	n := attempt(wf) + 1
	name, err := r.create(ctx, d, ActionRetire, false, map[string]string{AttemptAnnotation: strconv.Itoa(n)})
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleetd: the retirement Workflow %s ended at its BMC job at %s; fleetd started %s to try again (attempt %d)", wf.Name(), timestamp(endedAt(wf)), name, n)
	_, err = r.record(ctx, d, ActionRetire, name, "", comment)
	return err
}

// startRetire starts the retirement, which supersedes a run of another action
// that is still going. A deleted run's current action goes on, writes the disk
// and leaves the agent stuck reporting it, so fleetd deletes the run only once
// the machine is off. With a BMC, it asks Rufio to power the machine off
// (stopMachine); once the BMC reports it off, fleetd reads the run again,
// deletes it only while it is as that read shows it, and creates the
// retirement with a netboot. A BMC that refuses leaves the run, and the
// retirement waits for it to end, as it does without a BMC.
func (r *Reconciler) startRetire(ctx context.Context, d Device, workflows []Object) error {
	running := firstUnfinished(workflows)
	if running == nil || running.Labels()[ActionLabel] == ActionRetire {
		_, err := r.start(ctx, d, ActionRetire, workflows, false)
		return err
	}
	old, action := running.Name(), running.Labels()[ActionLabel]
	if !d.HasBMC() {
		why := fmt.Sprintf("fleetd: the retirement waits for Workflow %s (%s); power the machine off to end it, and it retires on its next network boot", old, action)
		return r.journalOnce(ctx, "retire-waits/"+old, d, "warning", why)
	}
	fresh, err := r.Kube.Get(ctx, WorkflowResource, old)
	switch {
	case errors.Is(err, ErrNotFound):
		_, err := r.start(ctx, d, ActionRetire, swap(workflows, old, nil), false)
		return err
	case err != nil:
		return fmt.Errorf("read %s: %w", old, err)
	case Finished(fresh.State()):
		_, err := r.start(ctx, d, ActionRetire, swap(workflows, old, fresh), false)
		return err
	}
	outcome, refusal, err := r.stopMachine(ctx, d, old, "power off: the retirement supersedes it")
	switch {
	case err != nil:
		return err
	case outcome == jobFailed:
		why := fmt.Sprintf("fleetd: the retirement waits for Workflow %s (%s): the BMC did not power the machine off (Rufio Job %s failed: %s). A deleted run's current action would go on, so fleetd keeps %s, and the retirement starts on the pass after it ends. Fix the BMC; or power the machine off by hand, and %s ends at its global timeout", old, action, stopJob(old), refusal, old, old)
		return r.journalOnce(ctx, "retire-waits/"+old, d, "warning", why)
	case outcome != jobCompleted:
		return nil
	}
	// The machine is off; a report may have landed while it powered off.
	fresh, err = r.Kube.Get(ctx, WorkflowResource, old)
	switch {
	case errors.Is(err, ErrNotFound):
		_, err := r.start(ctx, d, ActionRetire, swap(workflows, old, nil), false)
		return err
	case err != nil:
		return fmt.Errorf("read %s: %w", old, err)
	case Finished(fresh.State()):
		_, err := r.start(ctx, d, ActionRetire, swap(workflows, old, fresh), false)
		return err
	}
	err = r.Kube.DeleteUnchanged(ctx, WorkflowResource, old, fresh.ResourceVersion())
	if errors.Is(err, ErrConflict) {
		why := fmt.Sprintf("fleetd: the retirement could not end Workflow %s (%s), which changed between fleetd's read and its delete; the next pass tries again", old, action)
		return r.journalOnce(ctx, "supersede-conflict/"+old, d, "info", why)
	}
	if err != nil {
		return fmt.Errorf("end %s: %w", old, err)
	}
	Audit("fleet.workflow", r.Config.Site, d, old, "ended: the retirement supersedes it")
	if err := r.deleteFinished(ctx, workflows); err != nil {
		return err
	}
	name, err := r.create(ctx, d, ActionRetire, false, map[string]string{SupersedesAnnotation: old})
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleetd: the retirement ends Workflow %s (%s) and starts %s: the BMC powered the machine off (Rufio Job %s), which stopped %s, and fleetd deleted it", old, action, name, stopJob(old), old)
	_, err = r.record(ctx, d, ActionRetire, name, "", comment)
	return err
}

// swap replaces the named Workflow in the list with o, or drops it when o is
// nil.
func swap(workflows []Object, name string, o Object) []Object {
	out := make([]Object, 0, len(workflows))
	for _, wf := range workflows {
		switch {
		case wf.Name() != name:
			out = append(out, wf)
		case o != nil:
			out = append(out, o)
		}
	}
	return out
}

// abandon ends the unfinished retirement of a device the owner took out of
// decommissioning, and says whether it did. The owner cancelled a wipe, and a
// deleted retirement's action goes on and wipes the disk the owner chose to
// keep, so, as startRetire does, fleetd deletes it only once the BMC has
// powered the machine off (stopMachine), and only while the run is as a read
// just after shows it. A BMC that refuses, and a device without one, keep the
// retirement running, and the journal says once that the cancellation could
// not stop it.
func (r *Reconciler) abandon(ctx context.Context, d Device, wf Object) (bool, error) {
	name := wf.Name()
	if !d.HasBMC() {
		why := fmt.Sprintf("fleetd: %s left decommissioning while the retirement Workflow %s runs, and no BMC can stop the machine, so the cancellation cannot stop the retirement: it goes on and wipes the disk. Power the machine off by hand to stop it; the run then ends at its global timeout, and a new desired_action starts after it", d.Name, name)
		return false, r.journalOnce(ctx, "abandon-waits/"+name, d, "warning", why)
	}
	fresh, err := r.Kube.Get(ctx, WorkflowResource, name)
	switch {
	case errors.Is(err, ErrNotFound):
		return true, nil
	case err != nil:
		return false, fmt.Errorf("read %s: %w", name, err)
	case Finished(fresh.State()):
		return false, nil
	}
	outcome, refusal, err := r.stopMachine(ctx, d, name, "power off: the device left decommissioning")
	switch {
	case err != nil:
		return false, err
	case outcome == jobFailed:
		why := fmt.Sprintf("fleetd: %s left decommissioning, and the cancellation could not stop the retirement Workflow %s: the BMC did not power the machine off (Rufio Job %s failed: %s). A deleted retirement's action would go on, so fleetd keeps %s, and it goes on and wipes the disk. Power the machine off by hand to stop it; %s then ends at its global timeout, and a new desired_action starts after it", d.Name, name, stopJob(name), refusal, name, name)
		return false, r.journalOnce(ctx, "abandon-refused/"+name, d, "danger", why)
	case outcome != jobCompleted:
		return false, nil
	}
	// The machine is off; a report may have landed while it powered off.
	fresh, err = r.Kube.Get(ctx, WorkflowResource, name)
	switch {
	case errors.Is(err, ErrNotFound):
		return true, nil
	case err != nil:
		return false, fmt.Errorf("read %s: %w", name, err)
	case Finished(fresh.State()):
		return false, nil
	}
	err = r.Kube.DeleteUnchanged(ctx, WorkflowResource, name, fresh.ResourceVersion())
	if errors.Is(err, ErrConflict) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("abandon %s: %w", name, err)
	}
	Audit("fleet.workflow", r.Config.Site, d, name, "abandoned: the device left decommissioning")
	why := fmt.Sprintf("fleetd: %s left decommissioning, so the BMC powered the machine off (Rufio Job %s), which stopped the retirement Workflow %s, and fleetd deleted it. The disk may be partly wiped; set desired_action to provision to install the node again", d.Name, stopJob(name), name)
	return true, r.journalOnce(ctx, "abandoned/"+name, d, "warning", why)
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
	errs = append(errs, r.pruneJobs(ctx))
	return errors.Join(errs...)
}
