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

// declared is the owner's planned device for the box after its intake pass:
// the verifier wrote the MAC it proved and its verdict.
func declared(cf map[string]any) map[string]any {
	fields := map[string]any{"attest_verdict": "attested", "tpm_version": "2.0"}
	for k, v := range cf {
		fields[k] = v
	}
	return nbDevice(nodeID, "swell", "planned", boxSerial, g5, fields)
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
		apply:     true,
		devices:   devices,
		ifaces:    append(ifaces, switchIfaces()...),
		switches:  []map[string]any{{"id": 100, "name": "usw-24-poe"}},
		prefixes:  []map[string]any{{"id": 9, "prefix": "10.3.0.0/26"}},
		available: []string{"10.3.0.1/26", "10.3.0.2/26", "10.3.0.13/26", "10.3.0.14/26"},
	}
	at.kube = &fakeKube{}
	r, done := newTest(t, at.nb, at.kube)
	t.Cleanup(done)
	r.Config.AutoProvision = true
	r.Config.Installs = map[string]string{"worker-g5": "ghcr.io/jonpulsifer/talos-installer-folly:v1.14.4"}
	at.rend = &fakeRenderer{types: map[string]string{"worker-g5": "worker", "controlplane": "controlplane"}}
	r.Installer = &Installer{
		Site: "folly", NetBox: r.NetBox, Kube: r.Kube, Renderer: at.rend, Configs: &Configs{},
		TTL: 2 * time.Hour, Models: DefaultModels, Metrics: r.Metrics, Now: func() time.Time { return testNow },
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

func (at *admitTest) cabledTo(port int) bool {
	i := at.nb.ifaceByID(nodeNIC)
	for _, p := range i["link_peers"].([]any) {
		if p.(map[string]any)["id"] == switchPortID(port) {
			return true
		}
	}
	return false
}

func (at *admitTest) held(code string) bool {
	_, _, ok := at.r.Installer.Configs.Get(boxUUID, code, testNow)
	return ok
}

func reservedIP(id int, name, addr string) map[string]any {
	return map[string]any{"id": id, "address": addr, "dns_name": name, "status": "reserved", "assigned_object_type": nil, "assigned_object_id": nil}
}

// The declared device's intake pass binds it, starts its provision with no
// boot mode, since the machine waits in HookOS, and renders its config.
func TestAdmitBindsAndProvisions(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"expected_port": 5})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.nb.ips = []map[string]any{reservedIP(500, "swell", "10.3.0.13/26")}
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	n := at.node()
	if ip, _ := n["primary_ip4"].(map[string]any); ip == nil || ip["address"] != "10.3.0.13/26" {
		t.Errorf("primary_ip4 %v", n["primary_ip4"])
	}
	if ip := at.nb.ips[0]; fmt.Sprint(ip["assigned_object_id"]) != fmt.Sprint(nodeNIC) || ip["status"] != "active" {
		t.Errorf("the reserved address %v", ip)
	}
	if !at.cabledTo(5) {
		t.Errorf("no cable to Port 5: %v", at.nb.ifaceByID(nodeNIC))
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
	if !at.journal("cabled to usw-24-poe Port 5") || !at.journal("attested from HookOS, where it waits") {
		t.Errorf("journals %v", at.nb.journals)
	}
	if at.r.Metrics.Bound.Load() != 1 || at.r.Metrics.AutoProvisioned.Load() != 1 {
		t.Errorf("bound %d autoprovisioned %d", at.r.Metrics.Bound.Load(), at.r.Metrics.AutoProvisioned.Load())
	}

	// A second pass from the same boot renders under its new code in the
	// same run, and binds nothing again.
	patches, cables := len(at.nb.patches), len(at.nb.cables)
	again := strings.Repeat("Q", 43)
	if code, why := at.admit(again); code != http.StatusCreated {
		t.Fatalf("second admit: %d %s", code, why)
	}
	if n := at.kube.workflows(); len(n) != 1 || n[0] != names[0] {
		t.Fatalf("a second run started: %v", n)
	}
	if len(at.nb.cables) != cables || len(at.nb.patches) != patches {
		t.Errorf("a second admission wrote: %v", at.nb.patches[patches:])
	}
	if at.held(testCode) || !at.held(again) {
		t.Fatal("the older code's config survived")
	}
}

func TestAdmitAllocatesTheNextFreeAddress(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	// 10.3.0.1 is reserved.
	if ip, _ := at.node()["primary_ip4"].(map[string]any); ip == nil || ip["address"] != "10.3.0.2/26" {
		t.Fatalf("primary_ip4 %v", at.node()["primary_ip4"])
	}
	if ip := at.nb.ips[0]; ip["dns_name"] != "swell" || fmt.Sprint(ip["assigned_object_id"]) != fmt.Sprint(nodeNIC) {
		t.Errorf("allocated %v", ip)
	}
}

func TestAdmitUnknownModelGetsNoProvision(t *testing.T) {
	d := declared(nil)
	d["device_type"] = map[string]any{"model": "OptiPlex 7090"}
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	if code, why := at.admit(testCode); code != http.StatusConflict || !strings.Contains(why, "no class") {
		t.Fatalf("admit: %d %s", code, why)
	}
	if at.cf("talos_class") != nil || at.cf("install_disk") != nil || len(at.kube.workflows()) != 0 || at.held(testCode) {
		t.Errorf("class %v disk %v workflows %v", at.cf("talos_class"), at.cf("install_disk"), at.kube.workflows())
	}
	if !at.journal(`the model "OptiPlex 7090" is not in FLEET_MODEL_MAP`) || at.r.Metrics.AutoProvisioned.Load() != 0 {
		t.Errorf("journals %v", at.nb.journals)
	}
}

func TestAdmitNeverAutoProvisionsAControlPlane(t *testing.T) {
	for name, setup := range map[string]func(*admitTest){
		"the device's class": func(at *admitTest) {
			at.node()["custom_fields"].(map[string]any)["talos_class"] = ControlPlaneClass
		},
		"the model map's class": func(at *admitTest) {
			at.r.Config.Models = map[string]Model{g5: {Class: ControlPlaneClass, BMC: "amt", Disk: "/dev/nvme0n1"}}
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
	if len(at.nb.patches) != 0 || len(at.nb.ips) != 0 || len(at.nb.cables) != 0 || len(at.kube.workflows()) != 0 || at.held(testCode) {
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
		case ok && (code != http.StatusCreated || !at.cabledTo(24)):
			t.Errorf("expected_port 24: %d, interface %v, journals %v", code, at.nb.ifaceByID(nodeNIC), at.nb.journals)
		case !ok && (code != http.StatusConflict || len(at.nb.cables) != 0 || !at.journal("on port 24, expected 7 (swell)")):
			t.Errorf("expected_port 7: %d cables %v journals %v", code, at.nb.cables, at.nb.journals)
		}
	}
}

func TestAdmitWithoutLLDPLeavesTheCable(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	for _, f := range []string{"attested_switch", "attested_switch_port", "attested_network_at"} {
		at.node()["custom_fields"].(map[string]any)[f] = nil
	}
	if code, why := at.admit(testCode); code != http.StatusCreated {
		t.Fatalf("admit: %d %s", code, why)
	}
	if len(at.nb.cables) != 0 || len(at.kube.workflows()) != 1 {
		t.Errorf("cables %v workflows %v", at.nb.cables, at.kube.workflows())
	}
	if !at.journal("no switch port for the device, and no cable: the verifier recorded no attested switch port") {
		t.Errorf("journals %v", at.nb.journals)
	}
}

// An expected_port refuses a machine whose pass attested no port, or a port
// from more than an hour ago, as it refuses one on another port.
func TestAdmitWithoutAFreshPortRefusesAnExpectedPort(t *testing.T) {
	for name, mut := range map[string]func(*admitTest){
		"no Port <n>": func(at *admitTest) { at.node()["custom_fields"].(map[string]any)["attested_switch_port"] = "eth4" },
		"stale":       func(at *admitTest) { at.attest(rackMAC, testNow.Add(-2*time.Hour)) },
	} {
		t.Run(name, func(t *testing.T) {
			at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"expected_port": 5})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
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

func TestFillPortCablesANodeOnItsRackPort(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.attest(rackMAC, testNow)
	reconcile(t, at.r)
	if !at.cabledTo(5) || !at.journal("its intake pass attested a switch port") {
		t.Errorf("interface %v journals %v", at.nb.ifaceByID(nodeNIC), at.nb.journals)
	}
	reconcile(t, at.r)
	if len(at.nb.cables) != 1 {
		t.Errorf("a cabled node was cabled again: %v", at.nb.cables)
	}
}

func TestFillPortIgnoresAnOldReport(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.attest(rackMAC, testNow.Add(-2*time.Hour))
	reconcile(t, at.r)
	if len(at.nb.cables) != 0 {
		t.Errorf("an old report cabled the node: %v", at.nb.cables)
	}
}

// The attested port holds another device's cable in NetBox: the node gets no
// cable, the other one stays, and the owner reads the conflict.
func TestFillPortNeverStealsACable(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC), nic(60, 61, "eth0", "38:22:e2:00:00:61")})
	port5 := at.nb.ifaceByID(switchPortID(5))
	port5["cable"] = map[string]any{"id": 77}
	port5["link_peers"] = []any{map[string]any{"id": 60, "name": "eth0", "device": map[string]any{"name": "shale"}}}
	at.attest(rackMAC, testNow)
	reconcile(t, at.r)
	reconcile(t, at.r)
	if len(at.nb.cables) != 0 || len(at.nb.deleted) != 0 || port5["cable"] == nil {
		t.Errorf("a port with another cable was taken: cables %v deleted %v", at.nb.cables, at.nb.deleted)
	}
	if n := len(at.nb.journals); n != 1 || !at.journal("is cabled to another device in NetBox; no cable, and the other cable stays") {
		t.Errorf("journals %v", at.nb.journals)
	}
}

func TestFillPortJournalsANodeOffItsExpectedPort(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "expected_port": 7})
	cabled := nic(nodeNIC, nodeID, "eth0", rackMAC)
	cabled["cable"] = map[string]any{"id": 77}
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{cabled})
	at.attest(rackMAC, testNow)
	reconcile(t, at.r)
	reconcile(t, at.r)
	if len(at.nb.journals) != 1 || !at.journal("on port 5, expected 7") || len(at.nb.cables) != 0 {
		t.Errorf("journals %v cables %v", at.nb.journals, at.nb.cables)
	}
}

func reconcile(t *testing.T, r *Reconciler) {
	t.Helper()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestAllocatable(t *testing.T) {
	c := Config{NodePrefix: "10.3.0.0/26", NodeReserved: map[string]bool{"10.3.0.1": true}}
	for a, want := range map[string]bool{
		"10.3.0.0": false, "10.3.0.1": false, "10.3.0.2": true, "10.3.0.62": true, "10.3.0.63": false, "10.3.0.64": false, "bogus": false,
	} {
		if got := c.allocatable(a); got != want {
			t.Errorf("allocatable(%s) = %v", a, got)
		}
	}
}

func TestParseModels(t *testing.T) {
	m, err := ParseModels("")
	if err != nil || m[g5].Class != "worker-g5" || m[g5].BMC != "amt" || m[g5].Disk != "/dev/nvme0n1" {
		t.Fatalf("default %v %v", m, err)
	}
	m, err = ParseModels(`{"OptiPlex 3050":{"class":"controlplane","bmc":"none","disk":"/dev/sda"}}`)
	if err != nil || m["OptiPlex 3050"].Class != "controlplane" || len(m) != 1 {
		t.Fatalf("parsed %v %v", m, err)
	}
	if _, err := ParseModels(`{"x":`); err == nil {
		t.Error("broken JSON parsed")
	}
}

func TestAdmitFillsTheModelsHardwareFactsWhenEmpty(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.admit(testCode)
	for _, field := range []string{"amt", "secure_boot_expected"} {
		if got := at.cf(field); got != true {
			t.Errorf("%s = %v, want true", field, got)
		}
	}
}

func TestAdmitNeverOverwritesAHardwareFact(t *testing.T) {
	at := newAdmitTest(t, rackMAC, []map[string]any{declared(map[string]any{"amt": false, "secure_boot_expected": false})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.admit(testCode)
	for _, field := range []string{"amt", "secure_boot_expected"} {
		if got := at.cf(field); got != false {
			t.Errorf("%s = %v, want false", field, got)
		}
	}
}

func TestAdmitLeavesFactsOfAnUnknownModelEmpty(t *testing.T) {
	d := declared(nil)
	d["device_type"] = map[string]any{"model": "Unknown Box"}
	at := newAdmitTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	at.admit(testCode)
	for _, field := range []string{"amt", "secure_boot_expected"} {
		if got := at.cf(field); got != nil {
			t.Errorf("%s = %v, want it empty", field, got)
		}
	}
}

// A run starts only once the render's gates pass: a device whose model
// carries a TPM 2.0 renders once its tpm_version is recorded, so no
// Workflow wipes it before then.
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
