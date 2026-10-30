package fleet

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The machine rackMAC is on port 5 by its attested LLDP, and prepMAC on port
// 24, both on the switch switchMAC.
const (
	rackMAC   = "38:22:e2:aa:bb:05"
	prepMAC   = "38:22:e2:aa:bb:01"
	switchMAC = "f4:e2:c6:00:00:01"
	boxSerial = "MXL0172Q7X"
	boxUUID   = "4c4c4544-0042-3510-8051-b4c04f565499"
	g5        = "HP EliteDesk 800 G5 Desktop Mini"
	nodeID    = 40
	nodeNIC   = 41
)

func nbDevice(id int, name, status, serial, model string, cf map[string]any) map[string]any {
	fields := map[string]any{
		"install_disk": nil, "talos_class": nil, "tpm_version": nil, "bmc_type": nil,
		"desired_action": "none", "last_workflow": nil, "expected_port": nil, "attest_verdict": nil,
	}
	for k, v := range cf {
		fields[k] = v
	}
	return map[string]any{
		"id": id, "name": name, "serial": serial, "description": "",
		"status":        map[string]any{"value": status},
		"device_type":   map[string]any{"model": model},
		"primary_ip4":   nil,
		"oob_ip":        nil,
		"custom_fields": fields,
	}
}

// declared is the planned device Terraform applies for the box, with every
// declared field, after its intake pass: the verifier wrote the MAC it proved
// and its verdict.
func declared(cf map[string]any) map[string]any {
	fields := map[string]any{
		"attest_verdict": "attested", "tpm_version": "2.0", "talos_class": "worker-g5", "install_disk": "/dev/nvme0n1",
		"bmc_type": "amt", "amt": true, "secure_boot_expected": true, "expected_port": 5,
	}
	for k, v := range cf {
		fields[k] = v
	}
	d := nbDevice(nodeID, "swell", "planned", boxSerial, g5, fields)
	d["primary_ip4"] = map[string]any{"address": "10.3.0.13/26"}
	return d
}

func nic(id, device int, name, mac string) map[string]any {
	i := map[string]any{"id": id, "device": map[string]any{"id": device}, "name": name, "type": "1000base-t", "cable": nil, "link_peers": []any{}}
	if mac != "" {
		i["primary_mac_address"] = map[string]any{"mac_address": strings.ToUpper(mac)}
	}
	if name == "mgmt" {
		i["type"] = "virtual"
	}
	return i
}

func switchIfaces() []map[string]any {
	ifaces := []map[string]any{nic(101, 100, "mgmt", switchMAC)}
	for _, p := range []int{5, 7, 24} {
		ifaces = append(ifaces, nic(100+p+100, 100, fmt.Sprintf("Port %d", p), ""))
	}
	return ifaces
}

func switchPortID(p int) int { return 200 + p }

type admitTest struct {
	r    *Reconciler
	nb   *fakeNetBox
	kube *fakeKube
	rend *fakeRenderer
}

func newAdmitTest(t *testing.T, mac string, devices []map[string]any, ifaces []map[string]any) *admitTest {
	t.Helper()
	at := &admitTest{}
	at.nb = &fakeNetBox{
		apply:    true,
		devices:  devices,
		ifaces:   append(ifaces, switchIfaces()...),
		switches: []map[string]any{{"id": 100, "name": "usw-24-poe"}},
	}
	at.kube = &fakeKube{}
	r, done := newTest(t, at.nb, at.kube)
	t.Cleanup(done)
	r.Config.AutoProvision = true
	r.Config.Installs = map[string]string{"worker-g5": "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4"}
	at.rend = &fakeRenderer{types: map[string]string{"worker-g5": "worker", "controlplane": "controlplane"}}
	r.Installer = &Installer{
		Site: "folly", NetBox: r.NetBox, Kube: r.Kube, Renderer: at.rend, Configs: &Configs{},
		TTL: 2 * time.Hour, Metrics: r.Metrics, Now: func() time.Time { return testNow },
	}
	at.r = r
	// The intake pass attested the machine's port a minute ago.
	at.attest(mac, testNow.Add(-time.Minute))
	return at
}

// attest sets the node's attested network fields as the verifier writes them
// on a pass at the time: rackMAC on port 5, prepMAC on port 24.
func (at *admitTest) attest(mac string, when time.Time) {
	n := at.node()
	if n == nil {
		return
	}
	port := "Port 5"
	if mac == prepMAC {
		port = "Port 24"
	}
	cf := n["custom_fields"].(map[string]any)
	cf["attested_address"] = "10.3.0.50"
	cf["attested_switch"] = strings.ToUpper(switchMAC)
	cf["attested_switch_port"] = port
	cf["attested_network_at"] = when.UTC().Format(time.RFC3339)
}

func (at *admitTest) admit(code string) (int, string) {
	err := at.r.Admit(context.Background(), RenderRequest{Serial: boxSerial, UUID: boxUUID, Node: "swell", Code: code})
	if err == nil {
		return http.StatusCreated, ""
	}
	return status(err), err.Error()
}

func (at *admitTest) node() map[string]any {
	for _, d := range at.nb.devices {
		if d["id"] == nodeID {
			return d
		}
	}
	return nil
}

func (at *admitTest) cf(field string) any { return at.node()["custom_fields"].(map[string]any)[field] }

func (at *admitTest) journal(substr string) bool {
	for _, j := range at.nb.journals {
		if strings.Contains(j["comments"].(string), substr) {
			return true
		}
	}
	return false
}

func (at *admitTest) held(code string) bool {
	_, _, ok := at.r.Installer.Configs.Get(boxUUID, code, testNow)
	return ok
}

// The declared device's intake pass checks it, starts its provision with no
// boot mode, since the machine waits in HookOS, and renders its config.
func TestAdmitProvisionsADeclaredDevice(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	names := at.kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "provision-swell-") {
		t.Fatalf("workflows %v", names)
	}
	spec := at.kube.get(wfBase + names[0])["spec"].(map[string]any)
	if _, has := spec["bootOptions"].(map[string]any)["bootMode"]; has {
		t.Errorf("an admitted machine's provision boots by Rufio: %v", spec["bootOptions"])
	}
	if hm := spec["hardwareMap"].(map[string]any); hm["install"] != "true" {
		t.Errorf("hardwareMap %v", hm)
	}
	for field, want := range map[string]any{
		"talos_class": "worker-g5", "bmc_type": "amt", "install_disk": "/dev/nvme0n1",
		"last_workflow": names[0], "desired_action": "none",
	} {
		if got := at.cf(field); got != want {
			t.Errorf("%s = %v, want %v", field, got, want)
		}
	}
	if !at.held(testCode) || at.rend.calls != 1 {
		t.Fatal("the config was not rendered under the code")
	}
	if !at.journal("attested from HookOS, where it waits") || at.r.Metrics.AutoProvisioned.Load() != 1 {
		t.Errorf("journals %v autoprovisioned %d", at.nb.journals, at.r.Metrics.AutoProvisioned.Load())
	}

	// A second pass from the same boot renders under its new code in the
	// same run, and writes nothing again.
	patches := len(at.nb.patches)
	again := strings.Repeat("Q", 43)
	if code, why := at.admit(again); code != http.StatusCreated {
		t.Fatalf("second admit: %d %s", code, why)
	}
	if n := at.kube.workflows(); len(n) != 1 || n[0] != names[0] {
		t.Fatalf("a second run started: %v", n)
	}
	if len(at.nb.patches) != patches {
		t.Errorf("a second admission wrote: %v", at.nb.patches[patches:])
	}
	if at.held(testCode) || !at.held(again) {
		t.Fatal("the older code's config survived")
	}
}

// Terraform declares every field the install needs. A device that lacks one
// is refused, named in the journal, and nothing is written, so fleetd fills in
// nothing the declaration owns.
func TestAdmitRefusesAnIncompleteDeclaration(t *testing.T) {
	for field, name := range map[string]string{
		"talos_class": "talos_class", "install_disk": "install_disk", "bmc_type": "bmc_type", "tpm_version": "tpm_version",
		"amt": "amt", "secure_boot_expected": "secure_boot_expected", "expected_port": "expected_port",
	} {
		t.Run(name, func(t *testing.T) {
			at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{field: nil})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
			if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "lacks "+name) {
				t.Fatalf("admit: %d %s", code, why)
			}
			if len(at.nb.patches) != 0 || len(at.kube.workflows()) != 0 || at.held(testCode) {
				t.Errorf("a refused admission wrote: patches %v workflows %v", at.nb.patches, at.kube.workflows())
			}
			if !at.journal("lacks " + name) {
				t.Errorf("journals %v", at.nb.journals)
			}
		})
	}
	t.Run("primary_ip4", func(t *testing.T) {
		d := declared(nil)
		d["primary_ip4"] = nil
		at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
		if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "lacks primary_ip4") || len(at.nb.patches) != 0 {
			t.Fatalf("admit: %d %s, patches %v", code, why, at.nb.patches)
		}
	})
}

// A declared bmc_type of none and an amt of false are values, not blanks: the
// device admits and keeps them.
func TestAdmitKeepsAnExplicitNoBMC(t *testing.T) {
	d := declared(map[string]any{"bmc_type": "none", "amt": false, "secure_boot_expected": false})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	for field, want := range map[string]any{"bmc_type": "none", "amt": false, "secure_boot_expected": false} {
		if got := at.cf(field); got != want {
			t.Errorf("%s = %v, want %v", field, got, want)
		}
	}
}
func TestAdmitNeverAutoProvisionsAControlPlane(t *testing.T) {
	for name, setup := range map[string]func(*admitTest){
		"the device's class": func(at *admitTest) {
			at.node()["custom_fields"].(map[string]any)["talos_class"] = ControlPlaneClass
		},
	} {
		t.Run(name, func(t *testing.T) {
			at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
			setup(at)
			code, why := at.admit(testCode)
			if code != http.StatusConflict || !strings.Contains(why, "a control plane; the owner sets desired_action to provision by hand") {
				t.Fatalf("admit: %d %s", code, why)
			}
			if at.cf("talos_class") != ControlPlaneClass || len(at.kube.workflows()) != 0 || at.r.Metrics.AutoProvisioned.Load() != 0 {
				t.Errorf("class %v workflows %v", at.cf("talos_class"), at.kube.workflows())
			}
		})
	}
}

func TestAdmitChecksTheExpectedPort(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"expected_port": 7})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	for range 2 {
		if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "on port 5, expected 7 (swell)") {
			t.Fatalf("admit: %d %s", code, why)
		}
	}
	if len(at.nb.patches) != 0 || len(at.kube.workflows()) != 0 || at.held(testCode) {
		t.Errorf("a refused admission wrote: patches %v workflows %v", at.nb.patches, at.kube.workflows())
	}
	if len(at.nb.journals) != 1 || !at.journal("on port 5, expected 7 (swell)") {
		t.Errorf("journals %v", at.nb.journals)
	}
}

// Port 24 is a node port like any other.
func TestAdmitOnPort24IsLikeAnyPort(t *testing.T) {
	for want, ok := range map[int]bool{24: true, 7: false} {
		at := newAdmitTest(t, prepMAC, []map[string]any{declared(map[string]any{"expected_port": want})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", prepMAC)})
		code, _ := at.admit(testCode)
		switch {
		case ok && code != http.StatusCreated:
			t.Errorf("expected_port 24: %d, journals %v", code, at.nb.journals)
		case !ok && (code != http.StatusConflict || !at.journal("on port 24, expected 7 (swell)")):
			t.Errorf("expected_port 7: %d journals %v", code, at.nb.journals)
		}
	}
}

// A machine whose pass attested no port, or a port from more than an hour
// ago, is refused as one on another port is.
func TestAdmitWithoutAFreshPortIsRefused(t *testing.T) {
	for name, mut := range map[string]func(*admitTest){
		"no Port <n>": func(at *admitTest) { at.node()["custom_fields"].(map[string]any)["attested_switch_port"] = "eth4" },
		"no LLDP": func(at *admitTest) {
			for _, f := range []string{"attested_switch", "attested_switch_port", "attested_network_at"} {
				at.node()["custom_fields"].(map[string]any)[f] = nil
			}
		},
		"stale": func(at *admitTest) { at.attest(rackMAC, testNow.Add(-2*time.Hour)) },
	} {
		t.Run(name, func(t *testing.T) {
			at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
			mut(at)
			if code, _ := at.admit(testCode); code != http.StatusConflict {
				t.Fatalf("admit: %d", code)
			}
			if len(at.nb.patches) != 0 || len(at.kube.workflows()) != 0 {
				t.Errorf("a refused admission wrote: patches %v", at.nb.patches)
			}
			if !at.journal("its intake pass attested no switch port, and swell expects port 5") {
				t.Errorf("journals %v", at.nb.journals)
			}
		})
	}
}

// A device that ran a Workflow before waits for the owner; with
// desired_action provision it goes.
func TestAdmitAfterAnEarlierRunWaitsForTheOwner(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"last_workflow": "wipe-swell-1"})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "its last run is wipe-swell-1") {
		t.Fatalf("admit: %d %s", code, why)
	}
	if len(at.kube.workflows()) != 0 {
		t.Fatalf("workflows %v", at.kube.workflows())
	}
	at.node()["custom_fields"].(map[string]any)["desired_action"] = "provision"
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit with desired_action provision: %d %s", code, why)
	}
	if at.cf("desired_action") != "none" || at.r.Metrics.AutoProvisioned.Load() != 0 {
		t.Errorf("desired_action %v autoprovisioned %d", at.cf("desired_action"), at.r.Metrics.AutoProvisioned.Load())
	}
}

// The provision that netbooted the machine takes the code: no second run.
func TestAdmitRendersUnderTheRunningProvision(t *testing.T) {
	run := "provision-swell-1699990000"
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"last_workflow": run, "talos_class": "worker-g5", "install_disk": "/dev/nvme0n1", "bmc_type": "amt"})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	wf := workflowObject(run, "swell", "provision", testNow.Add(-5*time.Minute).UTC().Format(time.RFC3339), "STATE_RUNNING")
	wf["spec"] = map[string]any{"hardwareMap": map[string]any{"install": "true"}}
	at.kube.objects[wfBase+run] = wf
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	if n := at.kube.workflows(); len(n) != 1 || n[0] != run {
		t.Fatalf("workflows %v", n)
	}
	if !at.held(testCode) {
		t.Fatal("no config under the running provision")
	}
}

func TestAdmitRefusesADeviceThatIsNotPlanned(t *testing.T) {
	d := declared(nil)
	d["status"] = map[string]any{"value": "active"}
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, _ := at.admit(testCode); code != http.StatusConflict {
		t.Fatalf("admit: %d", code)
	}
	if len(at.nb.patches) != 0 || len(at.nb.journals) != 0 || len(at.kube.workflows()) != 0 {
		t.Errorf("an active device was admitted: %v", at.nb.patches)
	}
}

// A node off its expected port is journaled once, and never cabled: the cable
// is Terraform's, and a move after the port check is the owner's to judge.
func TestCheckPortJournalsANodeOffItsExpectedPort(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "expected_port": 7})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.attest(rackMAC, testNow)
	reconcile(t, at.r)
	reconcile(t, at.r)
	if len(at.nb.journals) != 1 || !at.journal("on port 5, expected 7") || len(at.nb.patches) != 0 {
		t.Errorf("journals %v patches %v", at.nb.journals, at.nb.patches)
	}
}

func TestCheckPortIgnoresAnOldReport(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "expected_port": 7})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.attest(rackMAC, testNow.Add(-2*time.Hour))
	reconcile(t, at.r)
	if len(at.nb.journals) != 0 {
		t.Errorf("journals %v", at.nb.journals)
	}
}
func reconcile(t *testing.T, r *Reconciler) {
	t.Helper()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
}

// A run starts only once the device is fully declared, so no Workflow wipes
// a disk the install cannot follow.
func TestAdmitStartsNoRunTheRenderRefuses(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"tpm_version": nil})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "tpm_version") {
		t.Fatalf("admit: %d %s", code, why)
	}
	if n := at.kube.workflows(); len(n) != 0 || at.held(testCode) || at.rend.calls != 0 {
		t.Fatalf("a run started that the render refuses: %v", n)
	}
}

// An admission waits for a reconcile pass, and gives up when its context
// ends, with nothing written.
func TestAdmitGivesUpWhileAPassRuns(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if err := at.r.lock(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := at.r.Admit(ctx, RenderRequest{Serial: boxSerial, UUID: boxUUID, Node: "swell", Code: testCode})
	if status(err) != http.StatusServiceUnavailable || len(at.nb.patches) != 0 || len(at.kube.workflows()) != 0 {
		t.Fatalf("admit during a pass: %v, patches %v", err, at.nb.patches)
	}
	at.r.unlock()
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit after the pass: %d %s", code, why)
	}
}

// fleetd expects a machine in HookOS when its device is planned or its last
// run has not finished; an active node with no run, or a finished one, is
// not expected, and neither is a serial NetBox lacks.
func TestExpected(t *testing.T) {
	run := "attest-swell-1699990000"
	for _, c := range []struct {
		name   string
		status string
		last   any
		state  string
		serial string
		want   bool
	}{
		{name: "planned", status: "planned", want: true},
		{name: "active with no run", status: "active"},
		{name: "active with a running run", status: "active", last: run, state: "STATE_RUNNING", want: true},
		{name: "active with a finished run", status: "active", last: run, state: "STATE_SUCCESS"},
		{name: "active with a pruned run", status: "active", last: run},
		{name: "unknown serial", status: "active", serial: "NOPE"},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := declared(map[string]any{"last_workflow": c.last})
			d["status"] = map[string]any{"value": c.status}
			at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
			if c.state != "" {
				at.kube.objects[wfBase+run] = workflowObject(run, "swell", "attest", testNow.UTC().Format(time.RFC3339), c.state)
			}
			serial := boxSerial
			if c.serial != "" {
				serial = c.serial
			}
			got, err := at.r.Expected(context.Background(), serial)
			if err != nil || got != c.want {
				t.Fatalf("Expected = %v, %v; want %v", got, err, c.want)
			}
		})
	}
}
