package fleet

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

// Rufio runs a Job's tasks in order as Tasks named <Job>-task-<n>, and fails
// the Job when one fails. The Job's message names only the Task; the Task's
// holds what the BMC answered. A power-off Task completes only once the BMC
// reports the machine off. Tinkerbell's controller names a Workflow's boot job
// netboot-<Workflow>, and nothing deletes a Job or its Tasks on its own.

// StopsAnnotation names the run a stop Job powers the machine off to end.
const StopsAnnotation = "lolwtf.ca/stops"

// SupersedesAnnotation, on a retirement, names the run it superseded.
const SupersedesAnnotation = "lolwtf.ca/supersedes"

// AttemptAnnotation, on a retirement, counts the retirements of the device
// since one ended at its BMC job; it is 1 when missing.
const AttemptAnnotation = "lolwtf.ca/attempt"

// Job outcomes, as Rufio's conditions name them; a Job that runs has none.
const (
	jobCompleted = "Completed"
	jobFailed    = "Failed"
)

func netbootJob(workflow string) string { return "netboot-" + workflow }

func stopJob(run string) string { return "stop-" + run }

// StopJob is the Rufio Job that powers the device's machine off, hard, to
// stop the current action of run.
func (c Config) StopJob(d Device, run string) Object {
	return Object{
		"apiVersion": JobResource.apiVersion(),
		"kind":       JobResource.Kind,
		"metadata": map[string]any{
			"name":        stopJob(run),
			"labels":      labels(d, nil),
			"annotations": map[string]any{StopsAnnotation: run},
		},
		"spec": map[string]any{
			"machineRef": map[string]any{"name": d.Name, "namespace": c.Namespace},
			"tasks":      []any{map[string]any{"powerAction": "off"}},
		},
	}
}

func jobTasks(job Object) int {
	spec, _ := job["spec"].(map[string]any)
	tasks, _ := spec["tasks"].([]any)
	return len(tasks)
}

// bmcJob reads a Rufio Job's outcome, empty while it runs, and for a failed
// Job the message of the Task that failed. A missing Job is ErrNotFound.
func (r *Reconciler) bmcJob(ctx context.Context, name string) (outcome, why string, err error) {
	job, err := r.Kube.Get(ctx, JobResource, name)
	if err != nil {
		return "", "", err
	}
	if s, _, _, _ := job.Condition(jobCompleted); s == "True" {
		return jobCompleted, "", nil
	}
	s, why, _, _ := job.Condition(jobFailed)
	if s != "True" {
		return "", "", nil
	}
	for i := range jobTasks(job) {
		task, err := r.Kube.Get(ctx, TaskResource, fmt.Sprintf("%s-task-%d", name, i))
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return "", "", err
		}
		// bmclib's errors span lines; the journal takes one.
		if s, m, _, _ := task.Condition(jobFailed); s == "True" && m != "" {
			return jobFailed, strings.Join(strings.Fields(m), " "), nil
		}
	}
	return jobFailed, why, nil
}

// stopMachine asks the BMC to power the device's machine off to stop run,
// once per run, audits why, and returns the stop Job's outcome. It waits up to
// Config.BMCJobWait for Rufio, and a Job still running is the next pass's to
// read.
func (r *Reconciler) stopMachine(ctx context.Context, d Device, run, reason string) (outcome, why string, err error) {
	name := stopJob(run)
	outcome, why, err = r.bmcJob(ctx, name)
	if errors.Is(err, ErrNotFound) {
		if err := r.Kube.Create(ctx, JobResource, r.Config.StopJob(d, run)); err != nil && !errors.Is(err, ErrConflict) {
			return "", "", fmt.Errorf("create Job %s: %w", name, err)
		}
		Audit("fleet.bmc", r.Config.Site, d, run, reason)
		outcome, why, err = r.bmcJob(ctx, name)
	}
	deadline := time.Now().Add(r.Config.BMCJobWait)
	for err == nil && outcome == "" && time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", "", ctx.Err()
		case <-time.After(time.Second):
		}
		outcome, why, err = r.bmcJob(ctx, name)
	}
	if err != nil {
		return "", "", fmt.Errorf("read Job %s: %w", name, err)
	}
	return outcome, why, nil
}

// deleteJob deletes one of fleetd's Rufio Jobs and its Tasks.
func (r *Reconciler) deleteJob(ctx context.Context, job Object) error {
	var errs []error
	for i := range jobTasks(job) {
		errs = append(errs, r.Kube.Delete(ctx, TaskResource, fmt.Sprintf("%s-task-%d", job.Name(), i)))
	}
	errs = append(errs, r.Kube.Delete(ctx, JobResource, job.Name()))
	return errors.Join(errs...)
}

// pruneJobs deletes fleetd's stop Jobs whose run is gone or has ended.
func (r *Reconciler) pruneJobs(ctx context.Context) error {
	jobs, err := r.Kube.List(ctx, JobResource, ManagedLabel+"="+FieldManager)
	if err != nil {
		return fmt.Errorf("list Jobs: %w", err)
	}
	var errs []error
	for _, job := range jobs {
		if run := job.Annotations()[StopsAnnotation]; run != "" {
			wf, err := r.Kube.Get(ctx, WorkflowResource, run)
			if err == nil && !Finished(wf.State()) {
				continue
			}
			if err != nil && !errors.Is(err, ErrNotFound) {
				errs = append(errs, err)
				continue
			}
		}
		if err := r.deleteJob(ctx, job); err != nil {
			errs = append(errs, fmt.Errorf("delete Job %s: %w", job.Name(), err))
		}
	}
	return errors.Join(errs...)
}

// bootJobFailure says why a Workflow that ran no action ended at its boot
// job: the BMC's answer from the Rufio Job, or the controller's condition when
// the Job is gone or never existed. It is false for any other Workflow.
func (r *Reconciler) bootJobFailure(ctx context.Context, wf Object) (string, bool, error) {
	if name, _, _ := wf.FailedAction(); name != "" {
		return "", false, nil
	}
	var cond string
	for _, kind := range []string{"BootJobFailed", "BootJobSetupFailed"} {
		if _, m, _, ok := wf.Condition(kind); ok {
			cond = m
			break
		}
	}
	if cond == "" {
		return "", false, nil
	}
	job := netbootJob(wf.Name())
	outcome, why, err := r.bmcJob(ctx, job)
	switch {
	case errors.Is(err, ErrNotFound):
		return fmt.Sprintf("its BMC job %s does not exist, and Tinkerbell says %q", job, cond), true, nil
	case err != nil:
		return "", false, fmt.Errorf("read Job %s: %w", job, err)
	case outcome == jobFailed && why != "":
		return fmt.Sprintf("its BMC job %s failed: %s", job, why), true, nil
	}
	log.Printf("Workflow %s: boot job %s is %q, and Tinkerbell says %q", wf.Name(), job, outcome, cond)
	return fmt.Sprintf("its BMC job %s failed, and Tinkerbell says %q", job, cond), true, nil
}

// endedAt is when a Workflow that failed at its boot job ended: the
// condition's time, else when fleetd journaled it, else its creation.
func endedAt(wf Object) time.Time {
	for _, kind := range []string{"BootJobFailed", "BootJobSetupFailed"} {
		if _, _, at, ok := wf.Condition(kind); ok && !at.IsZero() {
			return at
		}
	}
	if at, err := time.Parse(time.RFC3339, wf.Annotations()[EndedJournaledAnnotation]); err == nil {
		return at
	}
	return wf.Created()
}

// attempt is a retirement's AttemptAnnotation.
func attempt(wf Object) int {
	n := 0
	fmt.Sscan(wf.Annotations()[AttemptAnnotation], &n)
	return max(n, 1)
}

// Retries of a retirement that ended at its BMC job wait retryFirst after the
// first, then twice as long after each, up to retryMax.
const (
	retryFirst = 5 * time.Minute
	retryMax   = 4 * time.Hour
)

// retryAt is when fleetd starts a retirement again after wf ended at its BMC
// job.
func retryAt(wf Object) time.Time {
	wait := retryFirst
	for range attempt(wf) - 1 {
		if wait *= 2; wait >= retryMax {
			wait = retryMax
			break
		}
	}
	return endedAt(wf).Add(wait)
}

// PowerOffWait bounds how long a retirement whose Workflow reported success
// waits for the BMC to report the machine off before it gives up to the
// owner. Rufio refreshes a Machine's power status on its own schedule.
const PowerOffWait = 15 * time.Minute

// PowerWaitAnnotation marks a retirement Workflow with the time fleetd first
// found the BMC not reporting the machine off after the Workflow's success,
// so the wait holds across a restart.
const PowerWaitAnnotation = "lolwtf.ca/power-wait-started-at"

// machinePower is the power state Rufio's Machine reports: status.power, "on",
// "off" or "unknown", empty before Rufio has read it.
func machinePower(m Object) string {
	st, _ := m["status"].(map[string]any)
	p, _ := st["power"].(string)
	return strings.ToLower(p)
}

// corroborated says whether the BMC agrees with a retirement Workflow's
// success. The Tinkerbell channel is unauthenticated and the agent's identity
// is its MAC, so a SUCCESS state alone is a report any host on the network can
// make; the Machine's power status, which Rufio reads from the BMC, is not.
// A machine the BMC reports on, or does not answer for, waits: journaled once,
// and past PowerOffWait journaled once more as danger. Later passes read it
// again. The caller asks only for a device with a BMC.
func (r *Reconciler) corroborated(ctx context.Context, d Device, wf Object) (bool, error) {
	m, err := r.Kube.Get(ctx, MachineResource, d.Name)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return false, fmt.Errorf("read Machine %s: %w", d.Name, err)
	}
	power := machinePower(m)
	if err == nil && power == "off" {
		return true, nil
	}
	report := "reports the machine " + power
	if power == "" {
		report = "has not reported the machine's power state"
	}
	started, perr := time.Parse(time.RFC3339, wf.Annotations()[PowerWaitAnnotation])
	if perr != nil {
		started = r.Now().UTC()
		err := r.Kube.Annotate(ctx, WorkflowResource, wf.Name(), map[string]string{PowerWaitAnnotation: started.Format(time.RFC3339)})
		if err != nil && !errors.Is(err, ErrNotFound) {
			return false, fmt.Errorf("mark the power-off wait on %s: %w", wf.Name(), err)
		}
	}
	why := fmt.Sprintf("fleetd: Workflow %s reported success, and the BMC %s (Machine status.power); fleetd waits for the power-off before it takes the node out of the cluster", wf.Name(), report)
	if err := r.journalOnce(ctx, "power-waits/"+wf.Name(), d, "info", why); err != nil {
		return false, err
	}
	if r.Now().Sub(started) >= PowerOffWait {
		why := fmt.Sprintf("fleetd: Workflow %s reported success, and the BMC has not reported %s off for %s (it %s). The success may not be the agent's: the device stays decommissioning, and fleetd keeps reading the BMC. Check the machine and its Machine %s; power it off by hand, or move the device to offline after you have wiped it", wf.Name(), d.Name, PowerOffWait, strings.TrimPrefix(report, "reports "), d.Name)
		return false, r.journalOnce(ctx, "power-gaveup/"+wf.Name(), d, "danger", why)
	}
	return false, nil
}
