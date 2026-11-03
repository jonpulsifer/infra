package fleet

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/bmc"
)

// fakeBMC is one machine's BMC. Each call it takes lands in the fake Kube's
// log as "BMC <call>", so a test can order it against the API's writes.
type fakeBMC struct {
	mu    sync.Mutex
	kube  *fakeKube
	power string
	// refuse fails each named call as a BMC that answers 500 does.
	refuse map[string]bool
	// stuck takes a power-off and leaves the machine on.
	stuck bool
	calls []string
	// onCall, when set, runs as each call lands.
	onCall func(name string)
}

func (b *fakeBMC) call(name string) error {
	b.mu.Lock()
	b.calls = append(b.calls, name)
	refused := b.refuse[name]
	hook := b.onCall
	b.mu.Unlock()
	if hook != nil {
		hook(name)
	}
	b.kube.mu.Lock()
	b.kube.log = append(b.kube.log, "BMC "+name)
	b.kube.mu.Unlock()
	if refused {
		return errors.New("500 Internal Server Error")
	}
	return nil
}

func (b *fakeBMC) Power(context.Context) (string, error) {
	if err := b.call("power"); err != nil {
		return "", err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.power, nil
}

func (b *fakeBMC) PowerOff(context.Context) error {
	if err := b.call("off"); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.stuck {
		b.power = bmc.Off
	}
	return nil
}

func (b *fakeBMC) PowerOn(context.Context) error {
	if err := b.call("on"); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.power = bmc.On
	return nil
}

func (b *fakeBMC) PXEOnce(context.Context) error { return b.call("pxe") }

func (b *fakeBMC) set(power string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.power, b.stuck = power, false
}

func (b *fakeBMC) count(name string) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for _, c := range b.calls {
		if c == name {
			n++
		}
	}
	return n
}

func (f *fakeKube) logCount(line string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, l := range f.log {
		if l == line {
			n++
		}
	}
	return n
}

// native turns a test's reconciler to FLEET_BMC=native with one BMC for
// every device, its machine on.
func native(t *testing.T, r *Reconciler, kube *fakeKube) *fakeBMC {
	t.Helper()
	b := &fakeBMC{kube: kube, power: bmc.On, refuse: map[string]bool{}}
	r.Config.BMCMode = BMCNative
	r.BMC = func(Device) (bmc.BMC, error) { return b, nil }
	r.Runs = &Runs{File: filepath.Join(t.TempDir(), "bmc-runs.json")}
	return b
}

func run(t *testing.T, r *Reconciler, name string) Run {
	t.Helper()
	got, _, err := (&Runs{File: r.Runs.File}).Get(name)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func reconcileN(t *testing.T, r *Reconciler, n int) {
	t.Helper()
	for range n {
		if err := r.Reconcile(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
}

// In native mode fleetd network-boots the machine itself, as Tinkerbell's
// boot job does, before the Workflow exists, and makes nothing for Rufio.
func TestNativeProvisionNetbootsBeforeTheWorkflow(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	reconcileN(t, r, 2)

	names := kube.workflows()
	if len(names) != 1 {
		t.Fatalf("workflows %v", names)
	}
	if got := strings.Join(b.calls, ","); got != "off,power,pxe,on" {
		t.Errorf("BMC calls %s", got)
	}
	if on, create := kube.logIndex("BMC on"), kube.logIndex("POST "+strings.TrimSuffix(wfBase, "/")); on < 0 || create < on {
		t.Errorf("the Workflow was created before the power-on: %v", kube.log)
	}
	if kube.get(mPath) != nil || kube.posts(jobBase) != 0 {
		t.Error("native mode made a Rufio object")
	}
	if _, has := kube.get(hwPath)["spec"].(map[string]any)["bmcRef"]; has {
		t.Error("the Hardware names a Machine")
	}
	wf := kube.get(wfBase + names[0])
	if boot := wf["spec"].(map[string]any)["bootOptions"].(map[string]any); boot["bootMode"] != nil {
		t.Errorf("bootOptions %v", boot)
	}
	if rec := run(t, r, names[0]); rec.BootedAt.IsZero() || rec.BootFailed != "" || rec.Node != "riptide" {
		t.Errorf("run %+v", rec)
	}
	if len(nb.JournalWith("fleetd network-booted the machine through its BMC")) != 1 {
		t.Errorf("journals %v", nb.Journals)
	}
}

// Switching to native mode deletes the Machines fleetd made for Rufio.
func TestNativeDeletesTheMachine(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "none", nil)}, Ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	reconcileN(t, r, 1)
	if kube.get(mPath) == nil {
		t.Fatal("rufio mode made no Machine")
	}
	native(t, r, kube)
	reconcileN(t, r, 2)
	if kube.get(mPath) != nil {
		t.Error("the Machine outlived the switch to native mode")
	}
	if n := kube.logCount("GET " + mPath); n != 0 {
		t.Errorf("native passes read the Machine %d times", n)
	}
}

// A netboot the BMC refuses creates no Workflow, so no later boot of the
// machine runs it. The request is consumed and journaled once with the
// BMC's answer, the status stays, and the BMC is not asked again.
func TestNativeNetbootFailureCreatesNoWorkflow(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	b.refuse["on"] = true
	reconcileN(t, r, 3)

	if names := kube.workflows(); len(names) != 0 {
		t.Fatalf("workflows %v", names)
	}
	if b.count("on") != 1 || len(nb.Patches) != 1 {
		t.Fatalf("calls %v patches %v", b.calls, nb.Patches)
	}
	p := nb.Patches[0]
	cf := p["custom_fields"].(map[string]any)
	if _, has := p["status"]; has || cf["desired_action"] != "none" || !strings.HasPrefix(cf["last_workflow"].(string), "provision-riptide-") {
		t.Errorf("patch %v", p)
	}
	got := nb.JournalWith("did not start: the BMC did not network-boot the machine: power on: 500 Internal Server Error")
	if len(got) != 1 || !strings.Contains(got[0], "Fix the BMC, then set desired_action to run it again") {
		t.Errorf("journals %v", nb.Journals)
	}
	if rec := run(t, r, cf["last_workflow"].(string)); rec.BootFailed == "" || !rec.Recorded {
		t.Errorf("run %+v", rec)
	}
}

// A machine that takes longer than a pass's wait to go off, as an OS shutting
// down on a graceful soft off does, holds its netboot: no PXE, no power-on,
// no Workflow and the request kept, and the pass that finds it off goes on
// under the same name without a second power-off. One that stays on for
// powerOffTimeout fails.
func TestNativeNetbootWaitsForASlowPowerOff(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "wipe", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	now := testNow
	r.Now = func() time.Time { return now }
	b := native(t, r, kube)
	b.stuck = true
	reconcileN(t, r, 2)
	if b.count("pxe") != 0 || b.count("on") != 0 || b.count("off") != 1 || len(kube.workflows()) != 0 || len(nb.Patches) != 0 {
		t.Fatalf("calls %v workflows %v patches %v", b.calls, kube.workflows(), nb.Patches)
	}
	if len(nb.JournalWith("waits for the BMC to report the machine off before it network-boots it")) != 1 {
		t.Errorf("journals %v", nb.Journals)
	}
	name, pending, ok, _ := r.Runs.Latest("riptide")
	if !ok || !pending.pending() || !pending.BootOffRequested {
		t.Fatalf("run %q %+v", name, pending)
	}

	now = testNow.Add(3 * time.Minute)
	b.set(bmc.Off)
	reconcileN(t, r, 1)
	if names := kube.workflows(); len(names) != 1 || names[0] != name || b.count("off") != 1 || b.count("on") != 1 {
		t.Fatalf("workflows %v calls %v", names, b.calls)
	}
	if cf := lastPatch(nb)["custom_fields"].(map[string]any); cf["last_workflow"] != name || cf["desired_action"] != "none" {
		t.Errorf("patch %v", lastPatch(nb))
	}
}

func TestNativeNetbootFailsWhenTheMachineStaysOn(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "wipe", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	now := testNow
	r.Now = func() time.Time { return now }
	b := native(t, r, kube)
	b.stuck = true
	reconcileN(t, r, 1)
	now = testNow.Add(powerOffTimeout)
	reconcileN(t, r, 2)
	if b.count("pxe") != 0 || b.count("on") != 0 || len(kube.workflows()) != 0 || len(nb.Patches) != 1 {
		t.Fatalf("calls %v workflows %v patches %v", b.calls, kube.workflows(), nb.Patches)
	}
	if len(nb.JournalWith("the machine was not off 10m0s after the power-off (the BMC reports it on)")) != 1 {
		t.Errorf("journals %v", nb.Journals)
	}
}

// A pass that ends while the netboot waits, as at a restart of fleetd,
// records no failure and keeps the request; the next pass goes on.
func TestNativeNetbootSurvivesARestartMidWait(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	r.Config.BMCJobWait = time.Minute
	b := native(t, r, kube)
	b.stuck = true
	ctx, cancel := context.WithCancel(t.Context())
	b.onCall = func(name string) {
		if name == "power" {
			cancel()
		}
	}
	if err := r.Reconcile(ctx); err == nil {
		t.Fatal("a cancelled pass reported success")
	}
	b.onCall = nil
	if len(nb.Patches) != 0 || len(kube.workflows()) != 0 {
		t.Fatalf("patches %v workflows %v", nb.Patches, kube.workflows())
	}
	if _, last, _, _ := r.Runs.Latest("riptide"); !last.pending() {
		t.Fatalf("run %+v", last)
	}
	r.Config.BMCJobWait = 0
	b.set(bmc.Off)
	reconcileN(t, r, 1)
	if len(kube.workflows()) != 1 || b.count("off") != 1 || b.count("on") != 1 {
		t.Fatalf("workflows %v calls %v", kube.workflows(), b.calls)
	}
}

// Kea that refuses the boot file fails the pass before any power changes,
// and the request stays for the next pass.
func TestNativeNetbootNeedsKeaFirst(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	r.Kea = &KeaReservations{File: filepath.Join(t.TempDir(), "missing", "reservations.json"), BootFile: "ipxe.efi"}
	if err := r.Reconcile(t.Context()); err == nil || !strings.Contains(err.Error(), "boot file before the netboot") {
		t.Fatalf("pass: %v", err)
	}
	if len(b.calls) != 0 || len(kube.workflows()) != 0 || len(nb.Patches) != 0 {
		t.Fatalf("calls %v workflows %v patches %v", b.calls, kube.workflows(), nb.Patches)
	}
	if _, _, ok, _ := r.Runs.Latest("riptide"); ok {
		t.Error("a netboot that never reached the BMC left a record")
	}
}

// The boot file written before the power-on keeps the other devices' boot
// files, from Kea's file on the first pass after a restart.
func TestNativeNetbootKeepsTheOtherBootFiles(t *testing.T) {
	swell := mergeID(device("swell", "active", "none", nil), 8)
	swell["primary_ip4"] = map[string]any{"address": "10.3.0.13/26"}
	ifaces := append(riptideIfaces(), map[string]any{"id": 4, "device": map[string]any{"id": 8}, "primary_mac_address": map[string]any{"mac_address": "38:22:E2:2D:96:45"}})
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil), swell}, Ifaces: ifaces, Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	file := filepath.Join(t.TempDir(), "reservations.json")
	_ = os.WriteFile(file, []byte(`[{"hw-address":"38:22:e2:2d:96:45","ip-address":"10.3.0.13","hostname":"swell","boot-file-name":"ipxe.efi"}]`), 0o600)
	r.Kea = &KeaReservations{File: file, BootFile: "ipxe.efi"}
	var atPowerOn map[string]bool
	b.onCall = func(name string) {
		if name == "on" {
			atPowerOn = r.Kea.Netbooting()
		}
	}
	reconcileN(t, r, 1)
	if !atPowerOn["riptide"] || !atPowerOn["swell"] {
		t.Fatalf("boot files at the power-on %v", atPowerOn)
	}
}

// A failed netboot whose record NetBox refused is recorded on the next pass,
// not booted again.
func TestNativeNetbootFailureWhoseRecordFailedIsRecordedNotRetried(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "active", "provision", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	b.refuse["pxe"] = true
	nb.FailPatches(true)
	if err := r.Reconcile(t.Context()); err == nil {
		t.Fatal("a refused record did not fail the pass")
	}
	nb.FailPatches(false)
	reconcileN(t, r, 2)
	if b.count("pxe") != 1 || len(nb.Patches) != 1 || len(kube.workflows()) != 0 {
		t.Fatalf("calls %v patches %v", b.calls, nb.Patches)
	}
}

// A retirement whose netboot failed did nothing, so fleetd starts it again
// after the backoff, as one new run that counts the attempt in its record
// rather than on the Workflow.
func TestNativeRetirementRetriesAfterItsNetbootFailed(t *testing.T) {
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "decommissioning", "none", nil)}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	now := testNow
	r.Now = func() time.Time { return now }
	b := native(t, r, kube)
	b.refuse["off"] = true
	reconcileN(t, r, 3)
	if len(kube.workflows()) != 0 || b.count("off") != 1 {
		t.Fatalf("workflows %v calls %v", kube.workflows(), b.calls)
	}
	got := nb.JournalWith("did not start: the BMC did not network-boot the machine: power off: 500")
	if len(got) != 1 || !strings.Contains(got[0], "fleetd starts the retirement again at "+timestamp(testNow.Add(retryFirst))+" (attempt 2)") {
		t.Fatalf("journals %v", nb.Journals)
	}
	if nb.Journals[0]["kind"] != "danger" {
		t.Errorf("kind %v", nb.Journals[0]["kind"])
	}

	b.refuse["off"] = false
	now = testNow.Add(retryFirst)
	reconcileN(t, r, 2)
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("workflows %v", names)
	}
	if rec := run(t, r, names[0]); rec.Attempt != 2 {
		t.Errorf("attempt %d", rec.Attempt)
	}
	if _, has := kube.get(wfBase + names[0]).Annotations()[AttemptAnnotation]; has {
		t.Error("the Workflow carries the attempt")
	}
	if len(nb.JournalWith("fleetd started "+names[0]+" to try again (attempt 2)")) != 1 {
		t.Errorf("journals %v", nb.Journals)
	}
}

// The supersede powers the machine off through the BMC before it deletes the
// run, makes no Rufio Job, and boots the retirement.
func TestNativeSupersedePowersOffBeforeTheDelete(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, Ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	native(t, r, kube)
	reconcileN(t, r, 1)
	off, del := kube.logIndex("BMC off"), kube.logIndex("DELETE "+wfBase+prov)
	if off < 0 || del < 0 || off > del || kube.posts(jobBase) != 0 {
		t.Fatalf("the run was deleted before the power-off: %v", kube.log)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("workflows %v", names)
	}
	if len(nb.JournalWith("the BMC powered the machine off (at fleetd's request), which stopped "+prov)) != 1 {
		t.Errorf("journals %v", nb.Journals)
	}
	if rec := run(t, r, names[0]); rec.Supersedes != prov {
		t.Errorf("run %+v", rec)
	}
}

// A BMC that refuses the power-off leaves the run: fleetd asks once, says
// why once, and keeps the refusal in the run's record.
func TestNativeRetirementWaitsWhenTheBMCRefusesPowerOff(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, Ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	b.refuse["off"] = true
	reconcileN(t, r, 3)
	if names := kube.workflows(); len(names) != 1 || names[0] != prov || kube.deletes(prov) != 0 {
		t.Fatalf("a run the BMC could not stop was deleted: %v", names)
	}
	want := "fleetd: the retirement waits for Workflow " + prov + " (provision): the BMC did not power the machine off (power off: 500 Internal Server Error)"
	if b.count("off") != 1 || len(nb.Journals) != 1 || !strings.HasPrefix(nb.Journals[0]["comments"].(string), want) {
		t.Fatalf("calls %v journals %v", b.calls, nb.Journals)
	}
	if rec := run(t, r, prov); rec.Stop != jobFailed {
		t.Errorf("run %+v", rec)
	}
}

// A stop whose BMC fleetd could not open records nothing, so a later pass
// asks again rather than keeping the run for good.
func TestNativeStopThatNeverReachedTheBMCIsRetried(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, Ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	dial := r.BMC
	r.BMC = func(Device) (bmc.BMC, error) { return nil, errors.New("the BMC has no address") }
	if err := r.Reconcile(t.Context()); err == nil {
		t.Fatal("a stop that could not reach the BMC passed")
	}
	if rec := run(t, r, prov); rec.Stop != "" || len(nb.Journals) != 0 {
		t.Fatalf("run %+v journals %v", rec, nb.Journals)
	}
	r.BMC = dial
	reconcileN(t, r, 1)
	if names := kube.workflows(); len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") || b.count("off") < 1 {
		t.Fatalf("workflows %v calls %v", names, b.calls)
	}
}

// A power-off the BMC took holds the supersede over passes until the machine
// shows off, and fails once it has stayed on for powerOffTimeout.
func TestNativeSupersedeWaitsForThePowerOff(t *testing.T) {
	const prov = "provision-riptide-1"
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": prov})}, Ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + prov: installing(prov)}}
	r, done := newTest(t, nb, kube)
	defer done()
	now := testNow
	r.Now = func() time.Time { return now }
	b := native(t, r, kube)
	b.stuck = true
	reconcileN(t, r, 2)
	if kube.deletes(prov) != 0 || kube.creates() != 0 || len(nb.Journals) != 0 || b.count("off") != 1 {
		t.Fatalf("deletes %d creates %d journals %v calls %v", kube.deletes(prov), kube.creates(), nb.Journals, b.calls)
	}
	now = testNow.Add(powerOffTimeout)
	reconcileN(t, r, 2)
	if len(nb.JournalWith("the machine was not off 10m0s after the power-off")) != 1 || kube.deletes(prov) != 0 {
		t.Fatalf("journals %v", nb.Journals)
	}

	// Once the run ends, the retirement starts, and a new stop is a new run.
	kube.setState(prov, "STATE_SUCCESS")
	b.set(bmc.Off)
	reconcileN(t, r, 1)
	if names := kube.workflows(); len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("workflows %v", names)
	}
}

// A retirement's success waits for the BMC itself to report the machine
// off, and the wait's start lives in the run's record.
func TestNativeRetirementCorroboratesWithTheBMC(t *testing.T) {
	r, nb, kube, _ := newRetiredTest(t, "")
	b := native(t, r, kube)
	reconcileN(t, r, 2)
	if len(nb.Patches) != 0 || journaled(nb, "the BMC reports the machine on (read from the BMC)") != 1 {
		t.Fatalf("patches %v journals %v", nb.Patches, nb.Journals)
	}
	if rec := run(t, r, retireWF); rec.PowerWaitStartedAt.IsZero() {
		t.Errorf("run %+v", rec)
	}
	if _, has := kube.get(wfBase + retireWF).Annotations()[PowerWaitAnnotation]; has {
		t.Error("the wait is on the Workflow")
	}
	b.set(bmc.Off)
	reconcileN(t, r, 1)
	if lastPatch(nb)["status"] != "offline" {
		t.Fatalf("patches %v", nb.Patches)
	}
}

// Each run's record outlives a restart, and goes once nothing names its run.
func TestRunsPersistAndPrune(t *testing.T) {
	file := filepath.Join(t.TempDir(), "runs.json")
	s := &Runs{File: file}
	for _, name := range []string{"a", "b"} {
		if err := s.Put(name, Run{Node: "riptide", Action: "provision", BootedAt: testNow}); err != nil {
			t.Fatal(err)
		}
	}
	again := &Runs{File: file}
	if got, ok, err := again.Get("a"); err != nil || !ok || !got.BootedAt.Equal(testNow) {
		t.Fatalf("%+v %v %v", got, ok, err)
	}
	if err := again.Prune(func(name string, _ Run) bool { return name == "b" }); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := (&Runs{File: file}).Get("a"); ok {
		t.Error("a pruned run came back")
	}
	if err := os.WriteFile(file, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := (&Runs{File: file}).Get("b"); err == nil {
		t.Error("a torn file read as empty")
	}
}

// Latest is the node's newest netboot, whatever its action.
func TestLatestIsTheNewestNetboot(t *testing.T) {
	s := &Runs{File: filepath.Join(t.TempDir(), "runs.json")}
	_ = s.Put("provision-riptide-1", Run{Node: "riptide", Action: "provision", BootedAt: testNow, BootFailed: "power on: 500"})
	_ = s.Put("provision-riptide-2", Run{Node: "riptide", StopAt: testNow.Add(time.Hour)})
	if name, _, ok, _ := s.Latest("riptide"); !ok || name != "provision-riptide-1" {
		t.Fatalf("%q %v", name, ok)
	}
	_ = s.Put("wipe-riptide-3", Run{Node: "riptide", Action: "wipe", BootedAt: testNow.Add(time.Minute)})
	if name, _, _, _ := s.Latest("riptide"); name != "wipe-riptide-3" {
		t.Errorf("latest %q", name)
	}
}

// A failed netboot that NetBox already names, whose mark in Runs was lost,
// is marked, not journaled again, and the retirement's retry follows.
func TestNativeFailureNetBoxNamesIsNotRecordedTwice(t *testing.T) {
	const retire = "retire-riptide-1699990000"
	nb := &fakeNetBox{Devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": retire})}, Ifaces: riptideIfaces(), Apply: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	b := native(t, r, kube)
	_ = r.Runs.Put(retire, Run{Node: "riptide", Action: ActionRetire, BootedAt: testNow.Add(-time.Hour), BootFailed: "power off: 500"})
	reconcileN(t, r, 1)
	if len(nb.Patches) != 0 || len(nb.Journals) != 0 || len(b.calls) != 0 || !run(t, r, retire).Recorded {
		t.Fatalf("patches %v journals %v calls %v", nb.Patches, nb.Journals, b.calls)
	}
	reconcileN(t, r, 1)
	if names := kube.workflows(); len(names) != 1 || len(nb.JournalWith("to try again (attempt 2)")) != 1 {
		t.Fatalf("workflows %v journals %v", names, nb.Journals)
	}
}

func TestLoadConfigReadsTheBMCMode(t *testing.T) {
	t.Setenv("FLEET_HOOKOS_URL", "http://hookos")
	t.Setenv("FLEET_HOOKOS_CMDLINE", "console=tty0")
	dir := t.TempDir()
	classes := filepath.Join(dir, "classes.json")
	_ = os.WriteFile(classes, []byte(`{"w": {"os": "talos", "workload": "general", "template": "provision", "policy_profile": "talos", "payload_kind": "talos-machineconfig"}}`), 0o600)
	t.Setenv("FLEET_CLASSES", classes)
	t.Setenv("FLEET_BMC", "")
	cfg, err := LoadConfig()
	if err != nil || cfg.NativeBMC() {
		t.Fatalf("the default: %v %q", err, cfg.BMCMode)
	}
	if dial, runs, err := LoadBMC(cfg); dial != nil || runs != nil || err != nil {
		t.Fatalf("rufio mode loaded a BMC: %v", err)
	}
	t.Setenv("FLEET_BMC", "ipmi")
	if _, err := LoadConfig(); err == nil {
		t.Error("an unknown mode loaded")
	}
	t.Setenv("FLEET_BMC", BMCNative)
	if cfg, err = LoadConfig(); err != nil || !cfg.NativeBMC() {
		t.Fatalf("native: %v", err)
	}
	cred := filepath.Join(dir, "bmc-amt")
	_ = os.WriteFile(cred, []byte(`{"username":"admin","password":"x"}`), 0o600)
	t.Setenv("FLEET_BMC_AMT_CREDENTIAL_FILE", cred)
	t.Setenv("FLEET_BMC_STATE_FILE", "")
	if _, _, err := LoadBMC(cfg); err == nil {
		t.Error("native mode loaded without a state file")
	}
	t.Setenv("FLEET_BMC_STATE_FILE", filepath.Join(dir, "bmc-runs.json"))
	dial, runs, err := LoadBMC(cfg)
	if err != nil || runs == nil {
		t.Fatal(err)
	}
	if _, err := dial(Device{BMCType: "amt", BMCAddress: "10.3.0.12"}); err != nil {
		t.Error(err)
	}
}
