package fleet

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// installing is a provision six seconds into its install, with a deadline
// ahead.
func installing(name string) Object {
	return agedWorkflow(name, 6*time.Second, testNow.Add(29*time.Minute).UTC().Format(time.RFC3339), "STATE_RUNNING", "install")
}

func (f *fakeKube) deletes(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, l := range f.log {
		if l == "DELETE "+wfBase+name {
			n++
		}
	}
	return n
}

// A retirement of a device with a BMC supersedes the provision that installs:
// one pass deletes the provision while it is as listed, creates the retirement
// with a netboot, whose power cycle stops the install, and journals both once.
func TestRetirementSupersedesARunWithABMC(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("workflows %v", names)
	}
	retire := names[0]
	if boot := kube.get(wfBase + retire)["spec"].(map[string]any)["bootOptions"].(map[string]any); boot["bootMode"] != "netboot" {
		t.Errorf("the retirement does not power-cycle the machine: %v", boot)
	}
	if len(nb.patches) != 1 || nb.patches[0]["custom_fields"].(map[string]any)["last_workflow"] != retire {
		t.Fatalf("patches %v", nb.patches)
	}
	want := "fleetd: the retirement ends Workflow " + prov + " (provision) and starts " + retire + "; a power cycle stops " + prov
	if len(nb.journals) != 1 || nb.journals[0]["comments"] != want {
		t.Fatalf("journals %v", nb.journals)
	}
	nb.set("last_workflow", retire)
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(nb.journals) != 1 || len(nb.patches) != 1 || kube.creates() != 1 {
		t.Fatalf("a second pass wrote again: %v %v", nb.journals, nb.patches)
	}
}

// A run that changed between the pass's list and its delete, such as by an
// action's report, is kept and nothing is created; the next pass supersedes it.
func TestRetirementSupersedesOnlyTheRunItListed(t *testing.T) {
	const prov = "provision-riptide-1"
	moved := installing(prov)
	moved.metadata()["resourceVersion"] = "2"
	moved["status"].(map[string]any)["currentState"] = map[string]any{"actionName": "next-boot"}
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{
		objects: map[string]Object{wfBase + prov: installing(prov)},
		racing:  map[string]Object{wfBase + prov: moved},
	}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if names := kube.workflows(); len(names) != 1 || names[0] != prov || kube.creates() != 0 {
		t.Fatalf("a 409 on the delete still started the retirement: %v", names)
	}
	if len(nb.patches) != 0 || len(nb.journals) != 0 {
		t.Fatalf("patches %v journals %v", nb.patches, nb.journals)
	}
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if names := kube.workflows(); len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("the next pass did not supersede: %v", names)
	}
}

// Without a BMC nothing stops the machine, and a deleted run's action would
// go on, so the retirement waits for the run, says so once, and starts on the
// pass after the run ends.
func TestRetirementWaitsForARunWithoutABMC(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov, "bmc_type": "none"})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	for range 3 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if names := kube.workflows(); len(names) != 1 || names[0] != prov || kube.deletes(prov) != 0 {
		t.Fatalf("the run without a BMC was not kept: %v", names)
	}
	want := "fleetd: the retirement waits for Workflow " + prov + " (provision); power the machine off to end it, and it retires on its next network boot"
	if len(nb.journals) != 1 || nb.journals[0]["comments"] != want || len(nb.patches) != 0 {
		t.Fatalf("journals %v patches %v", nb.journals, nb.patches)
	}
	kube.setState(prov, "STATE_SUCCESS")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("workflows %v", names)
	}
	if _, has := kube.get(wfBase + names[0])["spec"].(map[string]any)["bootOptions"].(map[string]any)["bootMode"]; has {
		t.Error("a device without a BMC got a bootMode")
	}
}

// Leaving decommissioning ends a running retirement only with a BMC and only
// while it is as listed, and journals what happened.
func TestLeavingDecommissioningEndsTheRetirementSafely(t *testing.T) {
	const retire = "retire-riptide-1"
	running := func() Object {
		wf := installing(retire)
		wf.metadata()["labels"].(map[string]any)[ActionLabel] = ActionRetire
		return wf
	}
	t.Run("a run that changed is kept", func(t *testing.T) {
		moved := running()
		moved.metadata()["resourceVersion"] = "2"
		nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", map[string]any{"last_workflow": retire})}, ifaces: riptideIfaces()}
		kube := &fakeKube{objects: map[string]Object{wfBase + retire: running()}, racing: map[string]Object{wfBase + retire: moved}}
		r, done := newTest(t, nb, kube)
		defer done()
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
		if kube.get(wfBase+retire) == nil || len(nb.journals) != 0 {
			t.Fatalf("a changed retirement was deleted: journals %v", nb.journals)
		}
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
		if kube.get(wfBase+retire) != nil || len(nb.journalWith("deleted the unfinished retirement Workflow "+retire)) != 1 {
			t.Fatalf("the retirement survived: journals %v", nb.journals)
		}
	})
	t.Run("without a BMC", func(t *testing.T) {
		nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", map[string]any{"last_workflow": retire, "bmc_type": "none"})}, ifaces: riptideIfaces()}
		kube := &fakeKube{objects: map[string]Object{wfBase + retire: running()}}
		r, done := newTest(t, nb, kube)
		defer done()
		for range 2 {
			if err := r.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
		}
		if names := kube.workflows(); len(names) != 1 || names[0] != retire || kube.deletes(retire) != 0 {
			t.Fatalf("workflows %v", names)
		}
		if len(nb.journalWith("no BMC can stop the machine")) != 1 {
			t.Fatalf("journals %v", nb.journals)
		}
	})
}

// A config rendered for a planned device is dropped once the device leaves
// planned, so a node being retired never fetches the cluster's secrets.
func TestDecommissioningWithdrawsAnUnreadConfig(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "planned", "none", map[string]any{"last_workflow": prov})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	r.Installer = &Installer{
		Site: "folly", NetBox: r.NetBox, Kube: r.Kube, Configs: &Configs{},
		TTL: 2 * time.Hour, Metrics: r.Metrics, Now: func() time.Time { return testNow },
	}
	p := Pending{UUID: testUUID, Code: testCode, Serial: "MXL0172Q6L", Node: "riptide", Class: "worker-g5", Workflow: prov, Rendered: testNow, TTL: 2 * time.Hour}
	if err := r.Installer.Configs.Put(p, []byte("machine: {}\n")); err != nil {
		t.Fatal(err)
	}
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, held := r.Installer.Configs.Holds(testUUID); !held {
		t.Fatal("a planned device's config was dropped")
	}

	nb.set("status", map[string]any{"value": "decommissioning"})
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r.Installer.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/talos/config?uuid="+testUUID+"&code="+testCode, nil))
	r.Installer.Drain()
	if w.Code != http.StatusNotFound {
		t.Fatalf("a decommissioning node fetched its config: %d", w.Code)
	}
	if !r.Installer.Configs.Spent(testUUID, testCode) {
		t.Error("the withdrawn code is not burned")
	}
	if got := nb.journalWith("the device is decommissioning, so fleetd dropped the Talos config"); len(got) != 1 {
		t.Fatalf("journals %v", nb.journals)
	}
}
