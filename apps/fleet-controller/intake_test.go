package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	intakeMAC  = "38:22:e2:aa:bb:01"
	intakeSlug = "38-22-e2-aa-bb-01"
	hwBase     = "/apis/tinkerbell.org/v1alpha1/namespaces/tinkerbell/hardware/"
)

// intakeBody is the agent image's phone-home, in the shape it posts.
func intakeBody(mac string) string {
	b, _ := json.Marshal(map[string]any{
		"mac": mac, "serial": "MXL0172Q7X", "uuid": "4c4c4544-0042-3510-8051-b4c04f565433",
		"model": "HP EliteDesk 800 G5 Desktop Mini", "sku": "7PF35AV", "bios": "R21 Ver. 02.19.00",
		"disks": []map[string]any{
			{"name": "sda", "size": 31024349184, "tran": "usb"},
			{"name": "nvme0n1", "size": 512110190592, "tran": "nvme"},
		},
	})
	return string(b)
}

func TestIntakeDecodesTheAgentsBody(t *testing.T) {
	var req IntakeRequest
	body := `{"mac":"aa:bb:cc:00:00:02","serial":"CZC0000TST","uuid":"0d8c8f2e-1c3b-4a5d-9e6f-7a8b9c0d1e2f","model":"HP EliteDesk 800 G5 Desktop Mini","sku":"7PF33AV","bios":"R21 Ver. 02.19.00","disks":[{"name":"nvme0n1","size":512110190592,"tran":"nvme"},{"name":"sda","size":500107862016,"tran":"sata"}]}`
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatal(err)
	}
	if why := req.validate(); why != "" {
		t.Fatal(why)
	}
	if got := installDisk(req.Disks, Model{}); got != "/dev/nvme0n1" || req.Disks[1].Size != 500107862016 {
		t.Errorf("disk %q, sizes %v", got, req.Disks)
	}
}

type intakeTest struct {
	in   *Intake
	nb   *fakeNetBox
	kube *fakeKube
	now  time.Time
}

func newIntakeTest(t *testing.T, nb *fakeNetBox, kube *fakeKube) (*intakeTest, func()) {
	t.Helper()
	r, done := newTest(t, nb, kube)
	r.Config.Models = DefaultModels
	it := &intakeTest{nb: nb, kube: kube, now: testNow}
	it.in = &Intake{
		Config: &r.Config, NetBox: r.NetBox, Kube: r.Kube, Metrics: r.Metrics,
		Now:    func() time.Time { return it.now },
		PerMAC: 10 * time.Minute, Global: 20, Window: time.Hour,
	}
	return it, done
}

func (it *intakeTest) post(body string) (int, map[string]string) {
	req := httptest.NewRequest(http.MethodPost, "/intake", strings.NewReader(body))
	rec := httptest.NewRecorder()
	it.in.ServeHTTP(rec, req)
	var out map[string]string
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func TestIntakeCreatesHardwareAndAttestOnlyWorkflow(t *testing.T) {
	it, done := newIntakeTest(t, &fakeNetBox{}, &fakeKube{})
	defer done()
	code, out := it.post(intakeBody(intakeMAC))
	if code != http.StatusCreated || out["state"] != "intake" {
		t.Fatalf("%d %v", code, out)
	}
	wantWF := "intake-" + intakeSlug + "-1700000000"
	if out["workflow"] != wantWF {
		t.Errorf("workflow %q, want %q", out["workflow"], wantWF)
	}

	hw := it.kube.get(hwBase + intakeSlug)
	if hw == nil {
		t.Fatal("no Hardware")
	}
	l := hw.Labels()
	if l[IntakeLabel] != "true" || l[ManagedLabel] != FieldManager || l[NodeLabel] != intakeSlug {
		t.Errorf("labels %v", l)
	}
	if hw.annotation(SerialAnnotation) != "MXL0172Q7X" || hw.annotation(UUIDAnnotation) != "4c4c4544-0042-3510-8051-b4c04f565433" || hw.annotation(ModelAnnotation) != "HP EliteDesk 800 G5 Desktop Mini" {
		t.Errorf("annotations %v", hw.metadata()["annotations"])
	}
	if hardwareMAC(hw) != intakeMAC || hardwareDisk(hw) != "/dev/nvme0n1" {
		t.Errorf("mac %q disk %q", hardwareMAC(hw), hardwareDisk(hw))
	}
	spec := hw["spec"].(map[string]any)
	if _, has := spec["bmcRef"]; has {
		t.Error("an intake Hardware names a Machine")
	}
	ipxe := spec["interfaces"].([]any)[0].(map[string]any)["netboot"].(map[string]any)["ipxe"].(map[string]any)["contents"].(string)
	if !strings.Contains(ipxe, "chain --autofree http://10.9.0.11/hookos.efi console=tty0") {
		t.Errorf("ipxe %q", ipxe)
	}

	wf := it.kube.get(wfBase + wantWF)
	if wf == nil {
		t.Fatalf("no Workflow; have %v", it.kube.workflows())
	}
	ws := wf["spec"].(map[string]any)
	if ws["templateRef"] != "provision" || ws["hardwareRef"] != intakeSlug {
		t.Errorf("spec %v", ws)
	}
	hm := ws["hardwareMap"].(map[string]any)
	if hm["attest"] != "true" || hm["wipe"] != "false" || hm["install"] != "false" || hm["retire"] != "false" || hm["attest_url"] != "http://10.9.0.14/attest" {
		t.Errorf("hardwareMap %v", hm)
	}
	boot := ws["bootOptions"].(map[string]any)
	if _, has := boot["bootMode"]; has || boot["toggleAllowNetboot"] != true {
		t.Errorf("an intake boots by Rufio: %v", boot)
	}
	if wl := wf.Labels(); wl[IntakeLabel] != "true" || wl[ActionLabel] != ActionIntake || wl[NodeLabel] != intakeSlug {
		t.Errorf("workflow labels %v", wl)
	}
	if len(it.nb.patches) != 0 || len(it.nb.journals) != 0 {
		t.Errorf("an intake wrote to NetBox: %v %v", it.nb.patches, it.nb.journals)
	}
}

func TestIntakeKnownMACCreatesNothing(t *testing.T) {
	nb := &fakeNetBox{macs: []map[string]any{{
		"mac_address": strings.ToUpper(intakeMAC), "assigned_object_type": "dcim.interface",
		"assigned_object": map[string]any{"id": 3, "device": map[string]any{"name": "riptide"}},
	}}}
	kube := &fakeKube{}
	it, done := newIntakeTest(t, nb, kube)
	defer done()
	if code, out := it.post(intakeBody(intakeMAC)); code != http.StatusOK || out["state"] != "known" {
		t.Fatalf("NetBox MAC: %d %v", code, out)
	}
	if len(kube.objects) != 0 {
		t.Errorf("objects for a known MAC: %v", kube.objects)
	}

	other := "38:22:e2:aa:bb:02"
	kube.objects[hwBase+"riptide"] = Object{
		"metadata": map[string]any{"name": "riptide"},
		"spec":     map[string]any{"interfaces": []any{map[string]any{"dhcp": map[string]any{"mac": other}}}},
	}
	if code, out := it.post(intakeBody(other)); code != http.StatusOK || out["state"] != "known" {
		t.Fatalf("Hardware MAC: %d %v", code, out)
	}
	if len(kube.workflows()) != 0 || len(kube.objects) != 1 {
		t.Errorf("objects for a known Hardware: %v", kube.objects)
	}
}

func TestIntakeRateLimits(t *testing.T) {
	nb := &fakeNetBox{failMACs: true}
	it, done := newIntakeTest(t, nb, &fakeKube{})
	defer done()
	// A failed call gives its slot back, so the agent's retry is no 429.
	if code, _ := it.post(intakeBody(intakeMAC)); code != http.StatusServiceUnavailable {
		t.Fatalf("NetBox down: %d", code)
	}
	nb.mu.Lock()
	nb.failMACs = false
	nb.mu.Unlock()
	if code, _ := it.post(intakeBody(intakeMAC)); code != http.StatusCreated {
		t.Fatalf("retry: %d", code)
	}
	if code, _ := it.post(intakeBody(intakeMAC)); code != http.StatusTooManyRequests {
		t.Fatalf("second call within ten minutes: %d", code)
	}
	it.now = it.now.Add(10 * time.Minute)
	if code, out := it.post(intakeBody(intakeMAC)); code != http.StatusOK || out["state"] != "known" {
		t.Fatalf("after ten minutes: %d %v", code, out)
	}

	it.in.Global = 3
	if code, _ := it.post(intakeBody("38:22:e2:aa:bb:03")); code != http.StatusCreated {
		t.Fatalf("third in the hour: %d", code)
	}
	if code, _ := it.post(intakeBody("38:22:e2:aa:bb:04")); code != http.StatusTooManyRequests {
		t.Fatalf("over the global limit: %d", code)
	}
	it.now = it.now.Add(time.Hour)
	if code, _ := it.post(intakeBody("38:22:e2:aa:bb:04")); code != http.StatusCreated {
		t.Fatalf("an hour later: %d", code)
	}
	if n := it.in.Metrics.IntakeLimited.Load(); n != 2 {
		t.Errorf("limited %d", n)
	}
}

func TestIntakeValidation(t *testing.T) {
	it, done := newIntakeTest(t, &fakeNetBox{}, &fakeKube{})
	defer done()
	base := map[string]any{"mac": intakeMAC, "serial": "MXL0172Q7X", "uuid": "4c4c4544-0042-3510-8051-b4c04f565433"}
	for name, change := range map[string]map[string]any{
		"bad mac":       {"mac": "38:22:e2:aa:bb"},
		"multicast mac": {"mac": "01:00:5e:00:00:01"},
		"zero mac":      {"mac": "00:00:00:00:00:00"},
		"no serial":     {"serial": "  "},
		"long serial":   {"serial": strings.Repeat("X", 65)},
		"control":       {"serial": "MXL\n0172"},
		"non-ascii":     {"serial": "MXLé"},
		"bad uuid":      {"uuid": "4c4c4544-0042-3510-8051"},
		"bad disk":      {"disks": []map[string]any{{"name": "../sda", "size": 1}}},
		"string size":   {"disks": []map[string]any{{"name": "sda", "size": "28.9G"}}},
	} {
		body := map[string]any{}
		for k, v := range base {
			body[k] = v
		}
		for k, v := range change {
			body[k] = v
		}
		b, _ := json.Marshal(body)
		if code, _ := it.post(string(b)); code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, code)
		}
	}
	if code, _ := it.post(`{"mac":`); code != http.StatusBadRequest {
		t.Errorf("broken JSON: %d", code)
	}
	if code, _ := it.post(`{"mac":"` + strings.Repeat("a", 17<<10) + `"}`); code != http.StatusBadRequest {
		t.Errorf("oversized body: %d", code)
	}
	if len(it.kube.objects) != 0 {
		t.Errorf("objects from bad calls: %v", it.kube.objects)
	}
}

func TestInstallDisk(t *testing.T) {
	g5 := DefaultModels["HP EliteDesk 800 G5 Desktop Mini"]
	for _, c := range []struct {
		disks []IntakeDisk
		model Model
		want  string
	}{
		{[]IntakeDisk{{Name: "sda", Tran: "sata"}, {Name: "nvme0n1", Tran: "nvme"}}, Model{}, "/dev/nvme0n1"},
		{[]IntakeDisk{{Name: "sdb", Tran: "usb"}, {Name: "loop0"}, {Name: "sda", Tran: "sata"}}, Model{}, "/dev/sda"},
		{[]IntakeDisk{{Name: "sdb", Tran: "usb"}}, g5, "/dev/nvme0n1"},
		{nil, Model{}, ""},
	} {
		if got := installDisk(c.disks, c.model); got != c.want {
			t.Errorf("installDisk(%v) = %q, want %q", c.disks, got, c.want)
		}
	}
}

func TestExpireIntakes(t *testing.T) {
	old := testNow.Add(-25 * time.Hour).UTC().Format(time.RFC3339)
	fresh := testNow.Add(-time.Hour).UTC().Format(time.RFC3339)
	hw := func(slug, mac, created string) Object {
		return Object{
			"metadata": map[string]any{"name": slug, "creationTimestamp": created, "labels": map[string]any{
				ManagedLabel: FieldManager, NodeLabel: slug, IntakeLabel: "true",
			}},
			"spec": map[string]any{"interfaces": []any{map[string]any{"dhcp": map[string]any{"mac": mac}}}},
		}
	}
	intakeWF := func(name, slug, created string) Object {
		o := workflowObject(name, slug, ActionIntake, created, "STATE_FAILED")
		o.Labels()
		o.metadata()["labels"].(map[string]any)[IntakeLabel] = "true"
		return o
	}
	kube := &fakeKube{objects: map[string]Object{
		hwBase + "aa-00-00-00-00-01":          hw("aa-00-00-00-00-01", "aa:00:00:00:00:01", old),
		wfBase + "intake-aa-00-00-00-00-01-1": intakeWF("intake-aa-00-00-00-00-01-1", "aa-00-00-00-00-01", old),
		hwBase + "aa-00-00-00-00-02":          hw("aa-00-00-00-00-02", "aa:00:00:00:00:02", fresh),
		hwBase + "38-22-e2-2d-96-44":          hw("38-22-e2-2d-96-44", "38:22:e2:2d:96:44", old),
	}}
	// riptide holds the third MAC: its intake stays until it binds.
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", nil)}, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if kube.get(hwBase+"aa-00-00-00-00-01") != nil || kube.get(wfBase+"intake-aa-00-00-00-00-01-1") != nil {
		t.Error("an intake a day old with no device survived")
	}
	if kube.get(hwBase+"aa-00-00-00-00-02") == nil {
		t.Error("a fresh intake was deleted")
	}
	if kube.get(hwBase+"38-22-e2-2d-96-44") == nil {
		t.Error("an intake whose MAC a device holds was deleted")
	}
	if kube.get(hwPath) != nil {
		t.Error("riptide's own Hardware was applied while its intake holds the MAC")
	}
}
