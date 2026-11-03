package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/bmc"
)

// In native mode (FLEET_BMC=native) fleetd drives each device's BMC itself.
// It makes no Rufio Machine or Job, its Hardware names no Machine, and its
// Workflows carry no boot mode, so Tinkerbell's controller makes no boot job.
// Before it creates a Workflow that would netboot, fleetd does what that boot
// job does: power off, next boot PXE once, power on. The facts a Workflow's
// annotations and Rufio's Jobs hold in rufio mode live in Runs.

// errBootFailed is create's answer when the BMC did not netboot the machine:
// fleetd created no Workflow, and has recorded the run in NetBox.
var errBootFailed = errors.New("the BMC did not netboot the machine")

// stopTimeout is how long a native stop waits for the machine to go off
// before it fails, as Rufio fails a Task after 10 minutes.
const stopTimeout = 10 * time.Minute

// netboots says whether fleetd netboots the machine itself before it
// creates the run's Workflow.
func (r *Reconciler) netboots(d Device, hookos bool) bool {
	return r.Config.NativeBMC() && !hookos && d.HasBMC()
}

// openBMC opens the device's BMC.
func (r *Reconciler) openBMC(d Device) (bmc.BMC, error) {
	if r.BMC == nil {
		return nil, errors.New("fleetd has no BMC driver")
	}
	return r.BMC(d)
}

// netbootMachine records the run's attempt, then network-boots the device's
// machine through its BMC, as Tinkerbell's boot job does in rufio mode. Kea
// and the Hardware allow the netboot before the machine powers on. A failure
// is recorded in Runs and in NetBox, and is errBootFailed.
func (r *Reconciler) netbootMachine(ctx context.Context, d Device, name, action string, annotations map[string]string) error {
	run := Run{Node: d.Name, Action: action, Supersedes: annotations[SupersedesAnnotation], BootedAt: r.Now().UTC()}
	run.Attempt, _ = strconv.Atoi(annotations[AttemptAnnotation])
	if err := r.Runs.Put(name, run); err != nil {
		return fmt.Errorf("record the netboot of %s: %w", name, err)
	}
	Audit("fleet.bmc", r.Config.Site, d, name, "netboot: power off, next boot PXE, power on")
	r.allowNetbootNow(d)
	why := r.powerCycleToPXE(ctx, d)
	if why == "" {
		return nil
	}
	run.BootFailed = why
	if err := r.Runs.Put(name, run); err != nil {
		return fmt.Errorf("record the failed netboot of %s: %w", name, err)
	}
	return r.recordBootFailure(ctx, d, name, run)
}

// powerCycleToPXE is the boot job's three tasks, and says why it failed, or
// "". The power-off must show as off within BMCJobWait.
func (r *Reconciler) powerCycleToPXE(ctx context.Context, d Device) string {
	b, err := r.openBMC(d)
	if err != nil {
		return "open the BMC: " + err.Error()
	}
	if err := b.PowerOff(ctx); err != nil {
		return "power off: " + err.Error()
	}
	if off, why := r.waitOff(ctx, b, time.Now().Add(r.Config.BMCJobWait)); !off {
		return fmt.Sprintf("the machine was not off %s after the power-off (%s)", r.Config.BMCJobWait, why)
	}
	if err := b.PXEOnce(ctx); err != nil {
		return "set the next boot to PXE: " + err.Error()
	}
	if err := b.PowerOn(ctx); err != nil {
		return "power on: " + err.Error()
	}
	return ""
}

// waitOff reads the power state once, then every second until the
// deadline, and says whether the machine is off, or what the BMC last said.
func (r *Reconciler) waitOff(ctx context.Context, b bmc.BMC, deadline time.Time) (bool, string) {
	for {
		p, err := b.Power(ctx)
		if err == nil && p == bmc.Off {
			return true, ""
		}
		why := "the BMC reports it " + p
		if err != nil {
			why = "the BMC did not answer: " + err.Error()
		}
		if !time.Now().Before(deadline) {
			return false, why
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err().Error()
		case <-time.After(time.Second):
		}
	}
}

// allowNetbootNow writes Kea's reservations with the device's boot file
// before its machine powers on, since the pass's own write comes after.
// Devices the pass has not reached yet keep what the last pass decided.
func (r *Reconciler) allowNetbootNow(d Device) {
	if r.netboot != nil {
		r.netboot[d.Name] = true
	}
	if r.Kea == nil || len(r.devices) == 0 {
		return
	}
	netboot := map[string]bool{}
	for k, v := range r.lastNetboot {
		netboot[k] = v
	}
	for k, v := range r.netboot {
		netboot[k] = v
	}
	netboot[d.Name] = true
	if err := r.Kea.Sync(r.devices, netboot); err != nil {
		log.Printf("%s: kea before the netboot: %v", d.Name, err)
	}
}

// recordBootFailure names the failed run in NetBox, as a run that ended at
// its boot job: the request is consumed and the status left, since nothing
// ran. It is errBootFailed once NetBox has it.
func (r *Reconciler) recordBootFailure(ctx context.Context, d Device, name string, run Run) error {
	kind := "warning"
	why := fmt.Sprintf("fleetd: %s (%s) did not start: the BMC did not network-boot the machine: %s. fleetd created no Workflow, so the run did nothing. Fix the BMC, then set desired_action to run it again", name, run.Action, run.BootFailed)
	if run.Action == ActionRetire {
		kind = "danger"
		why = fmt.Sprintf("fleetd: the retirement %s did not start: the BMC did not network-boot the machine: %s", name, run.BootFailed)
		if run.Supersedes != "" {
			why += fmt.Sprintf(". The BMC had powered the machine off before fleetd deleted Workflow %s, which this retirement superseded, so %s stopped there, and the disk holds what it wrote until then", run.Supersedes, run.Supersedes)
		}
		why += fmt.Sprintf(". The disk is not wiped, so the node still holds its data and its identity, and the device stays decommissioning. fleetd starts the retirement again at %s (attempt %d); fix the BMC", timestamp(backoff(run.attempt(), run.BootedAt)), run.attempt()+1)
	}
	if _, err := r.recordAs(ctx, d, run.Action, name, "", kind, why); err != nil {
		return err
	}
	Audit("fleet.workflow", r.Config.Site, d, name, "ended at its netboot")
	run.Recorded = true
	if err := r.Runs.Put(name, run); err != nil {
		return fmt.Errorf("record %s: %w", name, err)
	}
	return errBootFailed
}

// retryNativeRetire starts the retirement again once run, the last one,
// failed at its netboot and its backoff has passed, as retryRetire does for
// a Workflow that ended at its boot job.
func (r *Reconciler) retryNativeRetire(ctx context.Context, d Device, last string, run Run, workflows []Object) error {
	if r.Now().Before(backoff(run.attempt(), run.BootedAt)) {
		return nil
	}
	if firstUnfinished(workflows) != nil {
		return r.startRetire(ctx, d, workflows)
	}
	if err := r.deleteFinished(ctx, workflows); err != nil {
		return err
	}
	n := run.attempt() + 1
	name, err := r.create(ctx, d, ActionRetire, false, map[string]string{AttemptAnnotation: strconv.Itoa(n)})
	if errors.Is(err, errBootFailed) {
		return nil
	}
	if err != nil {
		return err
	}
	comment := fmt.Sprintf("fleetd: the retirement %s ended at its netboot at %s; fleetd started %s to try again (attempt %d)", last, timestamp(run.BootedAt), name, n)
	_, err = r.record(ctx, d, ActionRetire, name, "", comment)
	return err
}

// stopNative powers the device's machine off to stop run, once per run,
// audits why, and returns the outcome Runs keeps: jobCompleted once the BMC
// reports it off, jobFailed when the BMC refused or the machine stayed on
// for stopTimeout, empty while it waits. It waits up to Config.BMCJobWait,
// and a later pass reads the power again.
func (r *Reconciler) stopNative(ctx context.Context, d Device, name, reason string) (string, string, error) {
	run, ok, err := r.Runs.Get(name)
	if err != nil {
		return "", "", err
	}
	if run.Stop != "" {
		return run.Stop, run.StopReason, nil
	}
	if !ok {
		run = Run{Node: d.Name}
	}
	fail := func(why string) (string, string, error) {
		run.Stop, run.StopReason = jobFailed, why
		return jobFailed, why, r.Runs.Put(name, run)
	}
	b, err := r.openBMC(d)
	if err != nil {
		return fail("open the BMC: " + err.Error())
	}
	if run.StopAt.IsZero() {
		run.StopAt = r.Now().UTC()
		if err := r.Runs.Put(name, run); err != nil {
			return "", "", err
		}
		Audit("fleet.bmc", r.Config.Site, d, name, reason)
		if err := b.PowerOff(ctx); err != nil {
			return fail("power off: " + err.Error())
		}
	}
	off, why := r.waitOff(ctx, b, time.Now().Add(r.Config.BMCJobWait))
	if off {
		run.Stop = jobCompleted
		return jobCompleted, "", r.Runs.Put(name, run)
	}
	if r.Now().Sub(run.StopAt) >= stopTimeout {
		return fail(fmt.Sprintf("the machine was not off %s after the power-off (%s)", stopTimeout, why))
	}
	return "", "", nil
}

// nativePower is the power state the BMC reports, or "" when it does not
// answer.
func (r *Reconciler) nativePower(ctx context.Context, d Device) string {
	b, err := r.openBMC(d)
	if err == nil {
		var p string
		if p, err = b.Power(ctx); err == nil {
			return p
		}
	}
	log.Printf("%s: read the power state: %v", d.Name, err)
	return ""
}

// stopped says, for the journal, how the BMC powered the machine off to stop
// run: through the Rufio Job, or at fleetd's request in native mode.
func (r *Reconciler) stopped(run string) string {
	if r.Config.NativeBMC() {
		return "at fleetd's request"
	}
	return "Rufio Job " + stopJob(run)
}

// refused says, for the journal, why the BMC did not power the machine off
// to stop run.
func (r *Reconciler) refused(run, why string) string {
	if r.Config.NativeBMC() {
		return why
	}
	return fmt.Sprintf("Rufio Job %s failed: %s", stopJob(run), why)
}
