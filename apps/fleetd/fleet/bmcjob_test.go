package fleet

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	jobBase  = "/apis/bmc.tinkerbell.org/v1alpha1/namespaces/tinkerbell/jobs/"
	taskBase = "/apis/bmc.tinkerbell.org/v1alpha1/namespaces/tinkerbell/tasks/"
)

func (f *fakeKube) posts(base string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, l := range f.log {
		if l == "POST "+strings.TrimSuffix(base, "/") {
			n++
		}
	}
	return n
}

func (f *fakeKube) logIndex(line string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Index(f.log, line)
}

func (f *fakeKube) completeJob(name string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	job := f.objects[jobBase+name]
	job["status"] = map[string]any{"conditions": []any{map[string]any{"type": "Completed", "status": "True"}}}
	job.metadata()["resourceVersion"] = bumped(job)
}

// The supersede powers the machine off through the BMC before it deletes the
// run, so the deleted run's action cannot go on.
func TestSupersedePowersOffBeforeTheDelete(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	post, del := kube.logIndex("POST "+strings.TrimSuffix(jobBase, "/")), kube.logIndex("DELETE "+wfBase+prov)
	if post < 0 || del < 0 || post > del {
		t.Fatalf("the run was deleted before the power-off: %v", kube.log)
	}
}

// A BMC that refuses to power the machine off leaves the run: fleetd deletes
// nothing, asks once, says why once, and starts the retirement on the pass
// after the run ends.
func TestRetirementWaitsWhenTheBMCRefusesPowerOff(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}, bmc: "refuse"}
	r, done := newTest(t, nb, kube)
	defer done()
	for range 3 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if names := kube.workflows(); len(names) != 1 || names[0] != prov || kube.deletes(prov) != 0 {
		t.Fatalf("a run the BMC could not stop was deleted: %v", names)
	}
	if kube.posts(jobBase) != 1 || len(nb.patches) != 0 {
		t.Fatalf("Job posts %d, patches %v", kube.posts(jobBase), nb.patches)
	}
	want := "fleetd: the retirement waits for Workflow " + prov + " (provision): the BMC did not power the machine off (Rufio Job stop-" + prov + " failed: failed to perform PowerAction: 500 Internal Server Error)"
	if len(nb.journals) != 1 || !strings.HasPrefix(nb.journals[0]["comments"].(string), want) {
		t.Fatalf("journals %v", nb.journals)
	}

	kube.setState(prov, "STATE_SUCCESS")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("the retirement did not start after the run: %v", names)
	}
	if kube.get(jobBase+"stop-"+prov) != nil || kube.get(taskBase+"stop-"+prov+"-task-0") != nil {
		t.Error("the failed stop Job and its Task outlived the run")
	}
}

// A stop Job Rufio has not run yet holds the supersede over passes, and the
// pass that finds it complete supersedes.
func TestSupersedeWaitsForThePowerOff(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}, bmc: "down"}
	r, done := newTest(t, nb, kube)
	defer done()
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if kube.deletes(prov) != 0 || kube.creates() != 0 || len(nb.journals) != 0 || kube.posts(jobBase) != 1 {
		t.Fatalf("deletes %d creates %d journals %v", kube.deletes(prov), kube.creates(), nb.journals)
	}
	kube.completeJob("stop-" + prov)
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") || len(nb.journalWith("the BMC powered the machine off")) != 1 {
		t.Fatalf("workflows %v journals %v", names, nb.journals)
	}
}

// bootFailed is a Workflow that ended FAILED at its boot job at the time, as
// Tinkerbell's controller leaves one whose Rufio Job failed.
func bootFailed(name, action string, at time.Time, annotations map[string]any) Object {
	wf := workflowObject(name, "riptide", action, at.Add(-time.Second).UTC().Format(time.RFC3339), "STATE_FAILED")
	wf.metadata()["resourceVersion"] = "1"
	wf.metadata()["annotations"] = annotations
	wf["status"].(map[string]any)["conditions"] = []any{
		map[string]any{"type": "BootJobSetupComplete", "status": "True", "message": "job created"},
		map[string]any{"type": "BootJobFailed", "status": "True", "reason": "Error", "message": "job failed", "time": at.UTC().Format(time.RFC3339)},
	}
	wf["status"].(map[string]any)["tasks"] = []any{map[string]any{"actions": []any{map[string]any{"name": "wipe-disk", "state": "STATE_PENDING"}}}}
	return wf
}

// failedNetbootJob is the Rufio Job and Task a refused power action leaves.
func failedNetbootJob(objects map[string]Object, wf string) {
	job := netbootJob(wf)
	objects[jobBase+job] = Object{"metadata": map[string]any{"name": job}, "spec": map[string]any{"tasks": []any{map[string]any{"powerAction": "off"}, map[string]any{}, map[string]any{"powerAction": "on"}}}, "status": map[string]any{
		"conditions": []any{map[string]any{"type": "Failed", "status": "True", "message": "task tinkerbell/" + job + "-task-0 failed"}},
	}}
	objects[taskBase+job+"-task-0"] = Object{"metadata": map[string]any{"name": job + "-task-0"}, "status": map[string]any{
		"conditions": []any{map[string]any{"type": "Failed", "status": "True", "message": "failed to perform PowerAction:\n\t500 Internal Server Error\n\n"}},
	}}
}

// A retirement that ended at its BMC job is journaled once with the BMC's
// answer and the run it superseded, never as an empty action, and fleetd
// starts it again once the backoff has passed, as one new run that counts
// the attempt.
func TestRetirementThatFailedAtItsBMCJobIsExplainedAndRetried(t *testing.T) {
	const retire, prov = "retire-riptide-1699999990", "provision-riptide-1699999900"
	failedAt := testNow.Add(-time.Minute)
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": retire})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + retire: bootFailed(retire, ActionRetire, failedAt, map[string]any{SupersedesAnnotation: prov})}}
	failedNetbootJob(kube.objects, retire)
	r, done := newTest(t, nb, kube)
	defer done()
	now := testNow
	r.Now = func() time.Time { return now }
	for range 3 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(nb.journals) != 1 || kube.creates() != 0 {
		t.Fatalf("journals %v creates %d", nb.journals, kube.creates())
	}
	got := nb.journals[0]["comments"].(string)
	for _, want := range []string{
		"Workflow " + retire + " ended FAILED before any action ran: its BMC job netboot-" + retire + " failed: failed to perform PowerAction: 500 Internal Server Error",
		"kubectl -n tinkerbell get machine riptide",
		"before fleetd deleted Workflow " + prov,
		"fleetd starts the retirement again at " + timestamp(failedAt.Add(retryFirst)) + " (attempt 2)",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("journal %q lacks %q", got, want)
		}
	}
	if strings.Contains(got, `action ""`) || strings.Contains(got, "console") {
		t.Errorf("journal %q names an empty action or the console", got)
	}
	if nb.journals[0]["kind"] != "danger" {
		t.Errorf("kind %v", nb.journals[0]["kind"])
	}

	now = failedAt.Add(retryFirst)
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") || names[0] == retire {
		t.Fatalf("workflows %v", names)
	}
	retry := names[0]
	if got := kube.get(wfBase + retry).Annotations()[AttemptAnnotation]; got != "2" {
		t.Errorf("attempt %q", got)
	}
	if len(nb.patches) != 1 || nb.patches[0]["custom_fields"].(map[string]any)["last_workflow"] != retry {
		t.Fatalf("patches %v", nb.patches)
	}
	if len(nb.journalWith("fleetd started "+retry+" to try again (attempt 2)")) != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
	nb.set("last_workflow", retry)
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if kube.creates() != 1 || len(nb.patches) != 1 {
		t.Fatalf("the retry ran twice: creates %d patches %v", kube.creates(), nb.patches)
	}
}

// A retirement whose record failed is adopted by the next pass, not retried
// again: the failed run is gone, and the newest retirement is the request's.
func TestARetryWhoseRecordFailedIsAdopted(t *testing.T) {
	const retire = "retire-riptide-1699999990"
	failedAt := testNow.Add(-time.Hour)
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": retire})}, ifaces: riptideIfaces(), apply: true}
	kube := &fakeKube{objects: map[string]Object{wfBase + retire: bootFailed(retire, ActionRetire, failedAt, nil)}}
	failedNetbootJob(kube.objects, retire)
	r, done := newTest(t, nb, kube)
	defer done()
	nb.failPatches(true)
	if err := r.Reconcile(context.Background()); err == nil {
		t.Fatal("a refused record did not fail the pass")
	}
	nb.failPatches(false)
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	names := kube.workflows()
	if len(names) != 1 || kube.creates() != 1 || len(nb.journalWith("its record was late")) != 1 {
		t.Fatalf("workflows %v creates %d journals %v", names, kube.creates(), nb.journals)
	}
}

// A provision that ended at its BMC job names the Job and is not retried; a
// boot job that never existed is named by Tinkerbell's own message.
func TestRunThatFailedAtItsBMCJobNamesTheJob(t *testing.T) {
	const prov, gone = "provision-riptide-1699999990", "wipe-riptide-1699999980"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{
		wfBase + prov: bootFailed(prov, "provision", testNow.Add(-time.Hour), nil),
		wfBase + gone: bootFailed(gone, "wipe", testNow.Add(-2*time.Hour), nil),
	}}
	failedNetbootJob(kube.objects, prov)
	r, done := newTest(t, nb, kube)
	defer done()
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(nb.journals) != 2 || kube.creates() != 0 {
		t.Fatalf("journals %v creates %d", nb.journals, kube.creates())
	}
	if len(nb.journalWith("its BMC job netboot-"+prov+" failed: failed to perform PowerAction: 500 Internal Server Error")) != 1 ||
		len(nb.journalWith("Fix the BMC, then set desired_action to run it again")) != 2 ||
		len(nb.journalWith(`its BMC job netboot-`+gone+` does not exist, and Tinkerbell says "job failed"`)) != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
}

func TestRetryBackoffDoublesToItsCap(t *testing.T) {
	at := testNow
	for n, want := range map[int]time.Duration{1: 5 * time.Minute, 2: 10 * time.Minute, 3: 20 * time.Minute, 6: 160 * time.Minute, 7: 4 * time.Hour, 40: 4 * time.Hour} {
		wf := bootFailed("retire-riptide-1", ActionRetire, at, map[string]any{AttemptAnnotation: strconv.Itoa(n)})
		if got := retryAt(wf).Sub(at); got != want {
			t.Errorf("attempt %d waits %s, want %s", n, got, want)
		}
	}
}
