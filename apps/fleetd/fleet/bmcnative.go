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

// errNetbootPending is create's answer while a netboot waits for the machine
// to go off: no Workflow yet, nothing recorded, and a later pass resumes it.
var errNetbootPending = errors.New("the netboot waits for the machine to go off")

// deferred says whether create's error leaves nothing more for its caller
// to do this pass.
func deferred(err error) bool {
	return errors.Is(err, errBootFailed) || errors.Is(err, errNetbootPending)
}

// powerOffTimeout is how long a native power-off, a netboot's or a stop's,
// may take before it fails, as Rufio fails a Task after 10 minutes. A
// graceful soft off waits for the OS to shut down.
const powerOffTimeout = 10 * time.Minute

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

// resumable says whether run, the device's newest netboot, is one a run of
// action goes on with: pending, and started no more than a couple of passes
// past powerOffTimeout ago. An older one belongs to a request the owner
// withdrew.
func (r *Reconciler) resumable(run Run, action string) bool {
	return run.Action == action && run.pending() && r.Now().Sub(run.BootedAt) <= powerOffTimeout+2*r.Config.Interval
}

// netbootMachine network-boots the device's machine for the run through its
// BMC, as Tinkerbell's boot job does in rufio mode: power off, next boot PXE
// once, power on. Each step is recorded in Runs as the BMC takes it, so a
// later pass resumes a netboot this one left. A machine that is not off
// within BMCJobWait is errNetbootPending, and fails once powerOffTimeout has
// passed. Kea gets the device's boot file before the first BMC call, and a
// Kea that refuses it fails the pass before any power changes. A failure is
// recorded in Runs and in NetBox, and is errBootFailed; a cancelled pass
// records nothing, and the next pass goes on.
func (r *Reconciler) netbootMachine(ctx context.Context, d Device, name string, run Run) error {
	if err := r.allowNetbootNow(d); err != nil {
		return fmt.Errorf("give %s its boot file before the netboot: %w", d.Name, err)
	}
	b, err := r.openBMC(d)
	if err != nil {
		return fmt.Errorf("open the BMC of %s: %w", d.Name, err)
	}
	fresh := !run.BootOffRequested
	if err := r.Runs.Put(name, run); err != nil {
		return fmt.Errorf("record the netboot of %s: %w", name, err)
	}
	if fresh {
		Audit("fleet.bmc", r.Config.Site, d, name, "netboot: power off, next boot PXE, power on")
		if err := b.PowerOff(ctx); err != nil {
			return r.netbootFailed(ctx, d, name, run, "power off: "+err.Error())
		}
		run.BootOffRequested = true
		if err := r.Runs.Put(name, run); err != nil {
			return fmt.Errorf("record the netboot of %s: %w", name, err)
		}
	}
	if off, why := r.waitOff(ctx, b, time.Now().Add(r.Config.BMCJobWait)); !off {
		switch {
		case ctx.Err() != nil:
			return ctx.Err()
		case r.Now().Sub(run.BootedAt) >= powerOffTimeout:
			return r.netbootFailed(ctx, d, name, run, fmt.Sprintf("the machine was not off %s after the power-off (%s)", powerOffTimeout, why))
		}
		why := fmt.Sprintf("fleetd: %s (%s) waits for the BMC to report the machine off before it network-boots it (%s); it fails at %s", name, run.Action, why, timestamp(run.BootedAt.Add(powerOffTimeout)))
		if err := r.journalOnce(ctx, "netboot-waits/"+name, d, "info", why); err != nil {
			return err
		}
		return errNetbootPending
	}
	if err := b.PXEOnce(ctx); err != nil {
		return r.netbootFailed(ctx, d, name, run, "set the next boot to PXE: "+err.Error())
	}
	if err := b.PowerOn(ctx); err != nil {
		return r.netbootFailed(ctx, d, name, run, "power on: "+err.Error())
	}
	run.Booted = true
	if err := r.Runs.Put(name, run); err != nil {
		return fmt.Errorf("record the netboot of %s: %w", name, err)
	}
	return nil
}

// netbootFailed records why the BMC did not netboot the machine, unless the
// pass's context ended, which leaves the netboot for the next pass.
func (r *Reconciler) netbootFailed(ctx context.Context, d Device, name string, run Run, why string) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	run.BootFailed = why
	if err := r.Runs.Put(name, run); err != nil {
		return fmt.Errorf("record the failed netboot of %s: %w", name, err)
	}
	return r.recordBootFailure(ctx, d, name, run)
}

// newRun is the record a new netboot starts with.
func (r *Reconciler) newRun(d Device, action string, annotations map[string]string) Run {
	run := Run{Node: d.Name, Action: action, Supersedes: annotations[SupersedesAnnotation], BootedAt: r.Now().UTC()}
	run.Attempt, _ = strconv.Atoi(annotations[AttemptAnnotation])
	return run
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
// Devices the pass has not reached yet keep what the last pass decided, or,
// on a pass after a restart, what Kea's file holds.
func (r *Reconciler) allowNetbootNow(d Device) error {
	if r.netboot != nil {
		r.netboot[d.Name] = true
	}
	if r.Kea == nil || len(r.devices) == 0 {
		return nil
	}
	netboot := r.lastNetboot
	if netboot == nil {
		netboot = r.Kea.Netbooting()
	}
	merged := map[string]bool{}
	for k, v := range netboot {
		merged[k] = v
	}
	for k, v := range r.netboot {
		merged[k] = v
	}
	merged[d.Name] = true
	return r.Kea.Sync(r.devices, merged)
}

// recordBootFailure names the failed run in NetBox, as a run that ended at
// its boot job: the request is consumed and the status left, since nothing
// ran. It is errBootFailed once NetBox has it. A run NetBox already names,
// whose mark in Runs was lost, is only marked.
func (r *Reconciler) recordBootFailure(ctx context.Context, d Device, name string, run Run) error {
	if d.LastWorkflow != name {
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
	}
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
	if deferred(err) {
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
// for powerOffTimeout, empty while it waits. It waits up to
// Config.BMCJobWait, and a later pass reads the power again. A request that
// never reached the BMC, for a BMC fleetd could not open or a pass that
// ended, records nothing and is an error, and a later pass asks again.
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
		return "", "", fmt.Errorf("open the BMC of %s: %w", d.Name, err)
	}
	if run.StopAt.IsZero() {
		Audit("fleet.bmc", r.Config.Site, d, name, reason)
		if err := b.PowerOff(ctx); err != nil {
			if ctx.Err() != nil {
				return "", "", ctx.Err()
			}
			return fail("power off: " + err.Error())
		}
		run.StopAt = r.Now().UTC()
		if err := r.Runs.Put(name, run); err != nil {
			return "", "", err
		}
	}
	off, why := r.waitOff(ctx, b, time.Now().Add(r.Config.BMCJobWait))
	if off {
		run.Stop = jobCompleted
		return jobCompleted, "", r.Runs.Put(name, run)
	}
	if ctx.Err() != nil {
		return "", "", ctx.Err()
	}
	if r.Now().Sub(run.StopAt) >= powerOffTimeout {
		return fail(fmt.Sprintf("the machine was not off %s after the power-off (%s)", powerOffTimeout, why))
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
