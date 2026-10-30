package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// An intake of rackMAC reports port 5 by LLDP, and one of prepMAC port 24,
// the prep station, both on the switch switchMAC.
const (
	rackMAC   = "38:22:e2:aa:bb:05"
	prepMAC   = "38:22:e2:aa:bb:01"
	switchMAC = "f4:e2:c6:00:00:01"
	boxSerial = "MXL0172Q7X"
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

func intakeDevice(model string, cf map[string]any) map[string]any {
	if cf == nil {
		cf = map[string]any{}
	}
	cf["attest_verdict"] = "attested"
	return nbDevice(nodeID, "intake-mxl0172q7x", "staged", boxSerial, model, cf)
}

func stubDevice(id int, name, serial, class string, port any) map[string]any {
	return nbDevice(id, name, "planned", serial, g5, map[string]any{"talos_class": class, "expected_port": port})
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
		i := nic(100+p+100, 100, fmt.Sprintf("Port %d", p), "")
		ifaces = append(ifaces, i)
	}
	return ifaces
}

func switchPortID(p int) int { return 200 + p }

// lldpReport is what an intake of the MAC reports at the time: the port the
// switch's LLDP frame names, in the shape a USW-24-PoE sends.
func lldpReport(mac string, at time.Time) map[string]any {
	port, name := 5, "rack-5"
	if mac == prepMAC {
		port, name = 24, "provisioning"
	}
	a := map[string]any{}
	for k, v := range (Report{At: at, Address: "10.9.0.150", Serial: boxSerial, LLDP: &LLDP{
		ChassisID: switchMAC, PortID: fmt.Sprintf("Port %d", port), PortDescription: name, SystemName: "USW-24-PoE",
	}}).annotations() {
		a[k] = v
	}
	return a
}

func intakeObjects(mac, state string) map[string]Object {
	slug := MACSlug(mac)
	created := testNow.Add(-time.Hour).UTC().Format(time.RFC3339)
	hw := Object{
		"metadata": map[string]any{"name": slug, "creationTimestamp": created,
			"labels":      map[string]any{ManagedLabel: FieldManager, NodeLabel: slug, IntakeLabel: "true"},
			"annotations": lldpReport(mac, testNow.Add(-time.Hour)),
		},
		"spec": map[string]any{
			"disks":      []any{map[string]any{"device": "/dev/sda"}},
			"interfaces": []any{map[string]any{"dhcp": map[string]any{"mac": mac}}},
		},
	}
	wf := workflowObject("intake-"+slug+"-1", slug, ActionIntake, created, state)
	wf.metadata()["labels"].(map[string]any)[IntakeLabel] = "true"
	return map[string]Object{hwBase + slug: hw, wfBase + "intake-" + slug + "-1": wf}
}

type bindTest struct {
	r    *Reconciler
	nb   *fakeNetBox
	kube *fakeKube
}

func newBindTest(t *testing.T, mac string, devices []map[string]any, ifaces []map[string]any) (*bindTest, func()) {
	t.Helper()
	bt := &bindTest{}
	bt.nb = &fakeNetBox{
		apply:     true,
		devices:   devices,
		ifaces:    append(ifaces, switchIfaces()...),
		switches:  []map[string]any{{"id": 100, "name": "usw-24-poe"}},
		prefixes:  []map[string]any{{"id": 9, "prefix": "10.3.0.0/26"}},
		available: []string{"10.3.0.1/26", "10.3.0.2/26", "10.3.0.13/26", "10.3.0.14/26"},
	}
	bt.kube = &fakeKube{objects: intakeObjects(mac, "STATE_SUCCESS")}
	r, done := newTest(t, bt.nb, bt.kube)
	r.Config.AutoProvision = true
	bt.r = r
	// The intake run's pass attested the machine's port half an hour ago,
	// after its Workflow was made.
	bt.attest(mac, testNow.Add(-30*time.Minute))
	return bt, done
}

// attest sets the node's attested network fields as talos-attest writes them
// on a pass at the time: rackMAC on port 5, prepMAC on port 24.
func (bt *bindTest) attest(mac string, at time.Time) {
	n := bt.node()
	if n == nil {
		return
	}
	port := "Port 5"
	if mac == prepMAC {
		port = "Port 24"
	}
	cf := n["custom_fields"].(map[string]any)
	cf["attested_address"] = "10.9.0.150"
	cf["attested_switch"] = strings.ToUpper(switchMAC)
	cf["attested_switch_port"] = port
	cf["attested_network_at"] = at.UTC().Format(time.RFC3339)
}

func (bt *bindTest) reconcile(t *testing.T) {
	t.Helper()
	if err := bt.r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func (bt *bindTest) node() map[string]any {
	for _, d := range bt.nb.devices {
		if d["id"] == nodeID {
			return d
		}
	}
	return nil
}

func (bt *bindTest) cf(field string) any { return bt.node()["custom_fields"].(map[string]any)[field] }

func (bt *bindTest) journal(substr string) bool {
	for _, j := range bt.nb.journals {
		if strings.Contains(j["comments"].(string), substr) {
			return true
		}
	}
	return false
}

func (bt *bindTest) cabledTo(port int) bool {
	i := bt.nb.ifaceByID(nodeNIC)
	for _, p := range i["link_peers"].([]any) {
		if p.(map[string]any)["id"] == switchPortID(port) {
			return true
		}
	}
	return false
}

func (bt *bindTest) intakeGone(mac string) bool {
	return bt.kube.get(hwBase+MACSlug(mac)) == nil && len(bt.kube.workflows()) == 0
}

func reservedIP(id int, name, addr string) map[string]any {
	return map[string]any{"id": id, "address": addr, "dns_name": name, "status": "reserved", "assigned_object_type": nil, "assigned_object_id": nil}
}

func TestBindTakesAStubAndProvisions(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 5)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.nb.ips = []map[string]any{reservedIP(500, "swell", "10.3.0.13/26")}
	bt.reconcile(t)

	if len(bt.nb.deleted) != 1 || bt.nb.deleted[0] != "swell" {
		t.Fatalf("deleted %v", bt.nb.deleted)
	}
	n := bt.node()
	if n["name"] != "swell" || n["description"] != "" {
		t.Errorf("name %v description %q", n["name"], n["description"])
	}
	if ip, _ := n["primary_ip4"].(map[string]any); ip == nil || ip["address"] != "10.3.0.13/26" {
		t.Errorf("primary_ip4 %v", n["primary_ip4"])
	}
	if ip := bt.nb.ips[0]; fmt.Sprint(ip["assigned_object_id"]) != fmt.Sprint(nodeNIC) || ip["status"] != "active" {
		t.Errorf("the reserved address %v", ip)
	}
	if !bt.cabledTo(5) {
		t.Errorf("no cable to Port 5: %v", bt.nb.ifaceByID(nodeNIC))
	}
	for field, want := range map[string]any{
		"talos_class": "worker-g5", "bmc_type": "amt", "install_disk": "/dev/nvme0n1",
		"last_workflow": "intake-38-22-e2-aa-bb-05-1", "desired_action": "provision",
	} {
		if got := bt.cf(field); got != want {
			t.Errorf("%s = %v, want %v", field, got, want)
		}
	}
	if !bt.intakeGone(rackMAC) {
		t.Errorf("intake objects survived: %v", bt.kube.objects)
	}
	if !bt.journal("took over the stub swell") || !bt.journal("cabled to usw-24-poe Port 5") {
		t.Errorf("journals %v", bt.nb.journals)
	}
	if bt.r.Metrics.Bound.Load() != 1 || bt.r.Metrics.AutoProvisioned.Load() != 1 {
		t.Errorf("bound %d autoprovisioned %d", bt.r.Metrics.Bound.Load(), bt.r.Metrics.AutoProvisioned.Load())
	}

	// The next pass provisions it. Its agent waits in HookOS from the intake,
	// and its AMT is on the bootstrap fallback, so Rufio stays out.
	bt.reconcile(t)
	names := bt.kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "provision-swell-") {
		t.Fatalf("workflows %v", names)
	}
	boot := bt.kube.get(wfBase + names[0])["spec"].(map[string]any)["bootOptions"].(map[string]any)
	if _, has := boot["bootMode"]; has {
		t.Errorf("a fresh intake's provision boots by Rufio: %v", boot)
	}
	if bt.kube.get(strings.Replace(mPath, "riptide", "swell", 1)) != nil {
		t.Error("a fresh intake got a Machine")
	}
	if hw := bt.kube.get(strings.Replace(hwPath, "riptide", "swell", 1)); hw == nil || hardwareMAC(hw) != rackMAC {
		t.Errorf("swell's Hardware %v", hw)
	}
	if !bt.journal("waits in HookOS from its intake") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

func TestBindWithoutStubAllocatesTheNextFreeAddress(t *testing.T) {
	bt, done := newBindTest(t, rackMAC, []map[string]any{intakeDevice(g5, nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.reconcile(t)
	// 10.3.0.1 is reserved.
	if ip, _ := bt.node()["primary_ip4"].(map[string]any); ip == nil || ip["address"] != "10.3.0.2/26" {
		t.Fatalf("primary_ip4 %v", bt.node()["primary_ip4"])
	}
	ip := bt.nb.ips[0]
	if ip["dns_name"] != "intake-mxl0172q7x" || fmt.Sprint(ip["assigned_object_id"]) != fmt.Sprint(nodeNIC) {
		t.Errorf("allocated %v", ip)
	}
	if bt.node()["name"] != "intake-mxl0172q7x" || len(bt.nb.deleted) != 0 {
		t.Errorf("name %v, deleted %v", bt.node()["name"], bt.nb.deleted)
	}
	if bt.cf("desired_action") != "provision" || !bt.intakeGone(rackMAC) {
		t.Errorf("desired_action %v, objects %v", bt.cf("desired_action"), bt.kube.objects)
	}
}

func TestBindUnknownModelGetsNoAutoProvision(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice("OptiPlex 7090", nil), stubDevice(20, "swell", "", "worker-g5", nil)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.reconcile(t)
	if bt.cf("desired_action") != "none" || bt.cf("talos_class") != nil {
		t.Errorf("desired_action %v class %v", bt.cf("desired_action"), bt.cf("talos_class"))
	}
	if len(bt.nb.deleted) != 0 {
		t.Errorf("an unknown model took a class stub: %v", bt.nb.deleted)
	}
	// The intake's disk is a claim, and a provision wipes it: it waits for
	// the owner.
	if bt.cf("install_disk") != nil {
		t.Errorf("install_disk %v from the claim", bt.cf("install_disk"))
	}
	if !bt.journal(`the model "OptiPlex 7090" is not in FLEET_MODEL_MAP`) {
		t.Errorf("journals %v", bt.nb.journals)
	}
	if !bt.intakeGone(rackMAC) || bt.r.Metrics.AutoProvisioned.Load() != 0 {
		t.Errorf("objects %v", bt.kube.objects)
	}
}

func TestBindNeverAutoProvisionsAControlPlane(t *testing.T) {
	for name, setup := range map[string]func(*bindTest) []map[string]any{
		"a stub's class": func(*bindTest) []map[string]any {
			return []map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", boxSerial, ControlPlaneClass, 5)}
		},
		"the model map's class": func(bt *bindTest) []map[string]any {
			bt.r.Config.Models = map[string]Model{g5: {Class: ControlPlaneClass, BMC: "amt", Disk: "/dev/nvme0n1"}}
			return []map[string]any{intakeDevice(g5, nil)}
		},
	} {
		t.Run(name, func(t *testing.T) {
			bt, done := newBindTest(t, rackMAC,
				[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", boxSerial, "worker-g5", 5)},
				[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
			defer done()
			if devices := setup(bt); devices != nil {
				bt.nb.devices = devices
				bt.attest(rackMAC, testNow.Add(-30*time.Minute))
			}
			if err := bt.r.Reconcile(t.Context()); err != nil {
				t.Fatal(err)
			}
			if bt.cf("talos_class") != ControlPlaneClass {
				t.Fatalf("talos_class %v", bt.cf("talos_class"))
			}
			if bt.cf("desired_action") != "none" || bt.r.Metrics.AutoProvisioned.Load() != 0 {
				t.Errorf("a control plane auto-provisioned: desired_action %v", bt.cf("desired_action"))
			}
			if !bt.journal("no auto-provision: a control plane; the owner sets desired_action to provision by hand") {
				t.Errorf("journals %v", bt.nb.journals)
			}
		})
	}
}

func TestBindOffThePrepStationChecksTheExpectedPort(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 7)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.reconcile(t)
	bt.reconcile(t)
	if len(bt.nb.patches) != 0 || len(bt.nb.deleted) != 0 || len(bt.nb.ips) != 0 || len(bt.nb.cables) != 0 {
		t.Errorf("a refused binding wrote: patches %v deleted %v", bt.nb.patches, bt.nb.deleted)
	}
	if len(bt.nb.journals) != 1 || !bt.journal("on port 5, expected 7 (stub swell)") {
		t.Errorf("journals %v", bt.nb.journals)
	}
	if bt.intakeGone(rackMAC) {
		t.Error("a refused binding ended the intake")
	}
	if bt.kube.get(strings.Replace(hwPath, "riptide", "intake-mxl0172q7x", 1)) != nil {
		t.Error("the device got its own Hardware beside the intake's")
	}
}

func TestBindAtThePrepStationCablesTheExpectedPort(t *testing.T) {
	bt, done := newBindTest(t, prepMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 7)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", prepMAC)})
	defer done()
	bt.reconcile(t)
	if bt.node()["name"] != "swell" || !bt.cabledTo(7) || bt.cabledTo(24) {
		t.Errorf("name %v, interface %v", bt.node()["name"], bt.nb.ifaceByID(nodeNIC))
	}
	if bt.cf("expected_port") != float64(7) || bt.cf("desired_action") != "provision" {
		t.Errorf("expected_port %v desired_action %v", bt.cf("expected_port"), bt.cf("desired_action"))
	}
	if !bt.journal("at the prep station on port 24") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

func TestBindAtThePrepStationLeavesATakenPortAlone(t *testing.T) {
	other := nic(60, 61, "eth0", "38:22:e2:00:00:61")
	bt, done := newBindTest(t, prepMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 7)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", prepMAC), other})
	defer done()
	port7 := bt.nb.ifaceByID(switchPortID(7))
	port7["cable"] = map[string]any{"id": 77}
	port7["link_peers"] = []any{map[string]any{"id": 60, "name": "eth0", "device": map[string]any{"name": "shale"}}}
	bt.reconcile(t)
	if len(bt.nb.cables) != 0 || len(bt.nb.deleted) != 1 {
		t.Errorf("a declared port took another node's cable: cables %v deleted %v", bt.nb.cables, bt.nb.deleted)
	}
	if !bt.journal("is cabled to another device in NetBox") || bt.node()["name"] != "swell" {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

func TestBindWithoutLLDPLeavesTheCable(t *testing.T) {
	bt, done := newBindTest(t, rackMAC, []map[string]any{intakeDevice(g5, nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	for _, f := range []string{"attested_switch", "attested_switch_port", "attested_network_at"} {
		bt.node()["custom_fields"].(map[string]any)[f] = nil
	}
	bt.reconcile(t)
	if len(bt.nb.cables) != 0 || bt.cf("desired_action") != "provision" || !bt.intakeGone(rackMAC) {
		t.Errorf("cables %v desired_action %v", bt.nb.cables, bt.cf("desired_action"))
	}
	if !bt.journal("no switch port for the device, and no cable: talos-attest recorded no attested switch port") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

// DC mode: a stub's expected_port refuses a machine whose pass attested no
// port, as it refuses one on another port.
func TestBindWithoutLLDPRefusesAnExpectedPort(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 5)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.node()["custom_fields"].(map[string]any)["attested_switch_port"] = "eth4"
	bt.reconcile(t)
	if len(bt.nb.patches) != 0 || len(bt.nb.deleted) != 0 || bt.intakeGone(rackMAC) {
		t.Errorf("a refused binding wrote: patches %v deleted %v", bt.nb.patches, bt.nb.deleted)
	}
	if !bt.journal("its intake pass attested no switch port, and stub swell expects port 5") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

// DC mode: a host on the bootstrap network forges the intake's LLDP to name
// the port a stub expects. The claim counts for nothing: the pass attested
// another port, and nothing binds.
func TestBindIgnoresAForgedIntakePort(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 7)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.kube.get(hwBase + MACSlug(rackMAC)).metadata()["annotations"].(map[string]any)[LLDPPortAnnotation] = "Port 7"
	bt.reconcile(t)
	if len(bt.nb.patches) != 0 || len(bt.nb.deleted) != 0 || len(bt.nb.cables) != 0 {
		t.Errorf("a forged port bound: patches %v deleted %v cables %v", bt.nb.patches, bt.nb.deleted, bt.nb.cables)
	}
	if !bt.journal("on port 5, expected 7 (stub swell)") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

// The intake's claim reaches the journal only as plain text: NetBox renders
// journal entries as Markdown.
func TestBindJournalsTheClaimedPortAsPlainText(t *testing.T) {
	bt, done := newBindTest(t, rackMAC, []map[string]any{intakeDevice(g5, nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.kube.get(hwBase + MACSlug(rackMAC)).metadata()["annotations"].(map[string]any)[LLDPPortAnnotation] = "Port 9 **[x](http://y)**"
	bt.reconcile(t)
	if !bt.journal("the intake claimed port Port 9") || !bt.cabledTo(5) {
		t.Fatalf("journals %v", bt.nb.journals)
	}
	for _, j := range bt.nb.journals {
		if c := j["comments"].(string); strings.ContainsAny(c, "*[]`") {
			t.Errorf("a journal entry carries Markdown: %s", c)
		}
	}
}

// A port attested before this intake's Workflow existed is another boot's,
// and says nothing of where the machine is now.
func TestBindIgnoresAnAttestedPortFromBeforeTheIntake(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", 5)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.attest(rackMAC, testNow.Add(-2*time.Hour))
	bt.reconcile(t)
	if len(bt.nb.patches) != 0 || len(bt.nb.deleted) != 0 {
		t.Errorf("a stale port bound: patches %v deleted %v", bt.nb.patches, bt.nb.deleted)
	}
	if !bt.journal("its intake pass attested no switch port, and stub swell expects port 5") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

func TestBindAtThePrepStationWithoutAPortLeavesTheCable(t *testing.T) {
	bt, done := newBindTest(t, prepMAC, []map[string]any{intakeDevice(g5, nil)}, []map[string]any{nic(nodeNIC, nodeID, "eth0", prepMAC)})
	defer done()
	bt.reconcile(t)
	if len(bt.nb.cables) != 0 {
		t.Errorf("cabled to the prep station: %v", bt.nb.cables)
	}
	if !bt.journal("no cable until an intake pass on a rack port attests it") || bt.cf("desired_action") != "provision" {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

func TestBindSerialStubWinsOverAnOlderClassStub(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", nil), stubDevice(21, "surge", strings.ToLower(boxSerial), "worker-g5", nil)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.reconcile(t)
	if bt.node()["name"] != "surge" || len(bt.nb.deleted) != 1 || bt.nb.deleted[0] != "surge" {
		t.Errorf("name %v deleted %v", bt.node()["name"], bt.nb.deleted)
	}
}

func TestBindStubBornDeviceKeepsItsName(t *testing.T) {
	// talos-attest took over the stub swell under the declared policy and
	// wrote the MAC it proved: the device keeps the stub's name.
	d := nbDevice(nodeID, "swell", "staged", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "attest_verdict": "attested", "expected_port": 5})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.nb.ips = []map[string]any{reservedIP(500, "swell", "10.3.0.13/26")}
	bt.reconcile(t)
	if ip, _ := bt.node()["primary_ip4"].(map[string]any); ip == nil || ip["address"] != "10.3.0.13/26" {
		t.Errorf("primary_ip4 %v", bt.node()["primary_ip4"])
	}
	if bt.node()["name"] != "swell" || bt.cf("desired_action") != "provision" || !bt.intakeGone(rackMAC) || !bt.cabledTo(5) {
		t.Errorf("name %v desired_action %v objects %v", bt.node()["name"], bt.cf("desired_action"), bt.kube.objects)
	}
}

// The claimed MAC of an intake never reaches NetBox. A forged intake for the
// serial whose fake agent reported SUCCESS binds nothing: the device waits
// for talos-attest to write the MAC its pass proved.
func TestBindNeverWritesAClaimedMAC(t *testing.T) {
	d := nbDevice(nodeID, "swell", "staged", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "attest_verdict": "attested"})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, nil)
	defer done()
	for p, o := range intakeObjects(prepMAC, "STATE_RUNNING") {
		bt.kube.objects[p] = o
	}
	bt.reconcile(t)
	bt.reconcile(t)
	if len(bt.nb.macs) != 0 || len(bt.nb.patches) != 0 || bt.cf("desired_action") != "none" {
		t.Errorf("macs %v patches %v", bt.nb.macs, bt.nb.patches)
	}
	if n := len(bt.nb.journals); n != 1 || !bt.journal("binds and provisions once talos-attest writes the MAC it proved") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

// A machine that phoned home before the owner declared it by hand: its
// failed intake goes, and the planned device's provision runs.
func TestPlannedDeviceDeclaredAfterAFailedIntakeProvisions(t *testing.T) {
	d := nbDevice(nodeID, "swell", "planned", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "install_disk": "/dev/nvme0n1", "desired_action": "provision"})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.kube.setState("intake-38-22-e2-aa-bb-05-1", "STATE_FAILED")
	bt.reconcile(t)
	if bt.kube.get(hwBase+MACSlug(rackMAC)) != nil {
		t.Fatalf("the failed intake survived: %v", bt.kube.objects)
	}
	names := bt.kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "provision-swell-") {
		t.Errorf("workflows %v", names)
	}
}

// A serial stub declared after the machine's intake failed does not keep
// that intake: it expires after an hour, and the machine phones home again.
func TestFailedIntakeExpiresDespiteASerialStub(t *testing.T) {
	d := nbDevice(nodeID, "swell", "planned", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, nil)
	defer done()
	bt.kube.setState("intake-38-22-e2-aa-bb-05-1", "STATE_FAILED")
	bt.reconcile(t)
	if bt.kube.get(hwBase+MACSlug(rackMAC)) != nil {
		t.Error("a failed intake an hour old survived")
	}
}

func TestBindLeavesAStubAnotherDeviceIsTakingOver(t *testing.T) {
	other := nbDevice(50, "intake-other", "staged", "OTHER1", g5, map[string]any{"talos_class": "worker-g5"})
	other["description"] = bindMarker + "swell"
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), other, stubDevice(20, "swell", "", "worker-g5", nil)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.reconcile(t)
	if bt.node()["name"] != "intake-mxl0172q7x" || len(bt.nb.deleted) != 0 {
		t.Errorf("took a promised stub: name %v deleted %v", bt.node()["name"], bt.nb.deleted)
	}
}

func TestBindIsIdempotent(t *testing.T) {
	bt, done := newBindTest(t, rackMAC,
		[]map[string]any{intakeDevice(g5, nil), stubDevice(20, "swell", "", "worker-g5", nil)},
		[]map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.reconcile(t)
	patches, ips, cables, journals := len(bt.nb.patches), len(bt.nb.ips), len(bt.nb.cables), len(bt.nb.journals)

	// The pass stopped before it deleted the intake: the next one finds the
	// device bound and only finishes.
	for p, o := range intakeObjects(rackMAC, "STATE_SUCCESS") {
		bt.kube.objects[p] = o
	}
	bt.reconcile(t)
	if len(bt.nb.patches) != patches || len(bt.nb.ips) != ips || len(bt.nb.cables) != cables || len(bt.nb.journals) != journals {
		t.Errorf("a second binding wrote: %v", bt.nb.patches[patches:])
	}
	if !bt.intakeGone(rackMAC) {
		t.Errorf("objects %v", bt.kube.objects)
	}
}

func TestBindWaitsForTheIntakeAndTheVerdict(t *testing.T) {
	bt, done := newBindTest(t, rackMAC, []map[string]any{intakeDevice(g5, map[string]any{})}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.kube.setState("intake-38-22-e2-aa-bb-05-1", "STATE_RUNNING")
	bt.reconcile(t)
	if len(bt.nb.patches) != 0 || len(bt.nb.journals) != 0 {
		t.Errorf("a running intake bound: %v", bt.nb.patches)
	}
	bt.kube.setState("intake-38-22-e2-aa-bb-05-1", "STATE_SUCCESS")
	bt.node()["custom_fields"].(map[string]any)["attest_verdict"] = "pending-approval"
	bt.reconcile(t)
	if len(bt.nb.patches) != 0 || !bt.journal("binds once it is staged and attested") {
		t.Errorf("patches %v journals %v", bt.nb.patches, bt.nb.journals)
	}
}

func TestFillPortCablesANodeOnItsRackPort(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.attest(rackMAC, testNow)
	bt.reconcile(t)
	if !bt.cabledTo(5) || !bt.journal("its intake pass attested a rack port") {
		t.Errorf("interface %v journals %v", bt.nb.ifaceByID(nodeNIC), bt.nb.journals)
	}
	bt.reconcile(t)
	if len(bt.nb.cables) != 1 {
		t.Errorf("a cabled node was cabled again: %v", bt.nb.cables)
	}
}

func TestFillPortIgnoresAnOldReport(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC)})
	defer done()
	bt.attest(rackMAC, testNow.Add(-2*time.Hour))
	bt.reconcile(t)
	if len(bt.nb.cables) != 0 {
		t.Errorf("an old report cabled the node: %v", bt.nb.cables)
	}
}

// The attested port holds another device's cable in NetBox: the node gets no
// cable, the other one stays, and the owner reads the conflict.
func TestFillPortNeverStealsACable(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5"})
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", rackMAC), nic(60, 61, "eth0", "38:22:e2:00:00:61")})
	defer done()
	port5 := bt.nb.ifaceByID(switchPortID(5))
	port5["cable"] = map[string]any{"id": 77}
	port5["link_peers"] = []any{map[string]any{"id": 60, "name": "eth0", "device": map[string]any{"name": "shale"}}}
	bt.attest(rackMAC, testNow)
	bt.reconcile(t)
	bt.reconcile(t)
	if len(bt.nb.cables) != 0 || len(bt.nb.deleted) != 0 || port5["cable"] == nil {
		t.Errorf("a port with another cable was taken: cables %v deleted %v", bt.nb.cables, bt.nb.deleted)
	}
	if n := len(bt.nb.journals); n != 1 || !bt.journal("is cabled to another device in NetBox; no cable, and the other cable stays") {
		t.Errorf("journals %v", bt.nb.journals)
	}
}

func TestFillPortJournalsANodeOffItsExpectedPort(t *testing.T) {
	d := nbDevice(nodeID, "swell", "active", boxSerial, g5, map[string]any{"talos_class": "worker-g5", "expected_port": 7})
	cabled := nic(nodeNIC, nodeID, "eth0", rackMAC)
	cabled["cable"] = map[string]any{"id": 77}
	bt, done := newBindTest(t, rackMAC, []map[string]any{d}, []map[string]any{cabled})
	defer done()
	bt.attest(rackMAC, testNow)
	bt.reconcile(t)
	bt.reconcile(t)
	if len(bt.nb.journals) != 1 || !bt.journal("on port 5, expected 7") || len(bt.nb.cables) != 0 {
		t.Errorf("journals %v cables %v", bt.nb.journals, bt.nb.cables)
	}
}

func TestFillPortIgnoresThePrepStation(t *testing.T) {
	d := nbDevice(nodeID, "swell", "staged", boxSerial, g5, nil)
	bt, done := newBindTest(t, prepMAC, []map[string]any{d}, []map[string]any{nic(nodeNIC, nodeID, "eth0", prepMAC)})
	defer done()
	bt.attest(prepMAC, testNow)
	bt.reconcile(t)
	if len(bt.nb.cables) != 0 {
		t.Errorf("cabled to the prep station: %v", bt.nb.cables)
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
