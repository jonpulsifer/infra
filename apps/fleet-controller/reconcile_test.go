package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeNetBox serves a device list and records the patches and journal
// entries it receives. pageSize > 0 pages the device list with next links
// that name a foreign host, as NetBox's do.
type fakeNetBox struct {
	mu        sync.Mutex
	devices   []map[string]any
	ifaces    []map[string]any
	patches   []map[string]any
	journals  []map[string]any
	failPatch bool
	pageSize  int
	pages     int
}

func (f *fakeNetBox) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/dcim/devices/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.pages++
		results := f.devices
		var next any
		if f.pageSize > 0 {
			offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
			end := offset + f.pageSize
			if end > len(f.devices) {
				end = len(f.devices)
			}
			results = f.devices[offset:end]
			if end < len(f.devices) {
				q := r.URL.Query()
				q.Set("offset", strconv.Itoa(end))
				next = "https://netbox.example/api/dcim/devices/?" + q.Encode()
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"count": len(f.devices), "next": next, "results": results})
	})
	mux.HandleFunc("GET /api/dcim/interfaces/", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"count": len(f.ifaces), "next": nil, "results": f.ifaces})
	})
	mux.HandleFunc("PATCH /api/dcim/devices/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.failPatch {
			http.Error(w, `{"detail":"down"}`, http.StatusBadGateway)
			return
		}
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		p["id"] = r.PathValue("id")
		f.patches = append(f.patches, p)
		w.Write([]byte("{}"))
	})
	mux.HandleFunc("POST /api/extras/journal-entries/", func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		f.mu.Lock()
		f.journals = append(f.journals, p)
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte("{}"))
	})
	return mux
}

// fakeKube stores objects by path and filters lists by label selector.
type fakeKube struct {
	mu      sync.Mutex
	objects map[string]Object
	log     []string
}

func matches(o Object, selector string) bool {
	if selector == "" {
		return true
	}
	l := o.Labels()
	for _, pair := range strings.Split(selector, ",") {
		k, v, _ := strings.Cut(pair, "=")
		if l[k] != v {
			return false
		}
	}
	return true
}

func (f *fakeKube) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.log = append(f.log, r.Method+" "+r.URL.Path)
		body, _ := io.ReadAll(r.Body)
		switch r.Method {
		case http.MethodPatch:
			if ct := r.Header.Get("Content-Type"); ct != "application/apply-patch+yaml" {
				http.Error(w, "content type "+ct, http.StatusUnsupportedMediaType)
				return
			}
			var o Object
			json.Unmarshal(body, &o)
			f.objects[r.URL.Path] = o
			w.Write([]byte("{}"))
		case http.MethodPost:
			var o Object
			json.Unmarshal(body, &o)
			path := r.URL.Path + "/" + o.Name()
			if _, dup := f.objects[path]; dup {
				http.Error(w, "exists", http.StatusConflict)
				return
			}
			o["metadata"].(map[string]any)["creationTimestamp"] = time.Now().UTC().Format(time.RFC3339)
			f.objects[path] = o
			w.WriteHeader(http.StatusCreated)
			w.Write([]byte("{}"))
		case http.MethodGet:
			if o, ok := f.objects[r.URL.Path]; ok {
				json.NewEncoder(w).Encode(o)
				return
			}
			items := []Object{}
			for p, o := range f.objects {
				if strings.HasPrefix(p, r.URL.Path+"/") && matches(o, r.URL.Query().Get("labelSelector")) {
					items = append(items, o)
				}
			}
			// group/version/namespaces/<ns>/<plural> is a list; one more segment names an object.
			if len(items) == 0 && strings.Count(strings.TrimPrefix(r.URL.Path, "/apis/"), "/") > 4 {
				http.NotFound(w, r)
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"items": items})
		case http.MethodDelete:
			if _, ok := f.objects[r.URL.Path]; !ok {
				http.NotFound(w, r)
				return
			}
			delete(f.objects, r.URL.Path)
			w.Write([]byte("{}"))
		}
	})
}

func (f *fakeKube) get(path string) Object {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.objects[path]
}

func (f *fakeKube) workflows() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var names []string
	for p := range f.objects {
		if strings.HasPrefix(p, wfBase) {
			names = append(names, strings.TrimPrefix(p, wfBase))
		}
	}
	return names
}

func (f *fakeKube) setState(name, state string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[wfBase+name]["status"] = map[string]any{"state": state}
}

func workflowObject(name, node, action, created, state string) Object {
	o := Object{"metadata": map[string]any{
		"name": name, "creationTimestamp": created,
		"labels": map[string]any{ManagedLabel: FieldManager, NodeLabel: node, ActionLabel: action},
	}}
	if state != "" {
		o["status"] = map[string]any{"state": state}
	}
	return o
}

func device(name, status, action string, cf map[string]any) map[string]any {
	fields := map[string]any{
		"install_disk":   "/dev/nvme0n1",
		"talos_class":    map[string]any{"value": "worker-g5", "label": "worker-g5"},
		"tpm_version":    "2.0",
		"bmc_type":       "amt",
		"desired_action": action,
		"last_workflow":  nil,
	}
	for k, v := range cf {
		fields[k] = v
	}
	return map[string]any{
		"id":            7,
		"name":          name,
		"serial":        "MXL0172Q6L",
		"status":        map[string]any{"value": status, "label": strings.ToUpper(status[:1]) + status[1:]},
		"primary_ip4":   map[string]any{"address": "10.3.0.12/26"},
		"oob_ip":        nil,
		"custom_fields": fields,
	}
}

func riptideIfaces() []map[string]any {
	return []map[string]any{{
		"id": 3, "device": map[string]any{"id": 7},
		"primary_mac_address": map[string]any{"mac_address": "38:22:E2:2D:96:44"},
	}}
}

func (f *fakeNetBox) set(field string, value any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if field == "status" {
		f.devices[0]["status"] = value
		return
	}
	f.devices[0]["custom_fields"].(map[string]any)[field] = value
}

var testNow = time.Unix(1_700_000_000, 0)

func newTest(t *testing.T, nb *fakeNetBox, kube *fakeKube) (*Reconciler, func()) {
	t.Helper()
	if kube.objects == nil {
		kube.objects = map[string]Object{}
	}
	nbs := httptest.NewServer(nb.handler())
	ks := httptest.NewServer(kube.handler())
	cfg := Config{
		Site: "folly", Namespace: "tinkerbell", Template: "provision",
		HookOSURL: "http://10.9.0.11/hookos.efi", HookOSCmdline: "console=tty0",
		AttestURL: "http://10.9.0.14/attest", NTPServer: "10.9.0.14",
		Interval: time.Minute, WorkflowTTL: 7 * 24 * time.Hour,
		BMCSecrets:  map[string]string{"amt": "bmc-amt", "redfish": "bmc-redfish"},
		RedfishPort: 443, AMTPort: 16992,
	}
	now := testNow
	r := &Reconciler{
		Config:  cfg,
		NetBox:  &NetBox{URL: nbs.URL, Token: "nbt_x.y", Client: nbs.Client()},
		Kube:    &Kube{Server: ks.URL, Namespace: "tinkerbell", Client: ks.Client()},
		Metrics: NewMetrics(),
		Now:     func() time.Time { now = now.Add(time.Second); return now },
	}
	return r, func() { nbs.Close(); ks.Close() }
}

const (
	hwPath = "/apis/tinkerbell.org/v1alpha1/namespaces/tinkerbell/hardware/riptide"
	mPath  = "/apis/bmc.tinkerbell.org/v1alpha1/namespaces/tinkerbell/machines/riptide"
	wfBase = "/apis/tinkerbell.org/v1alpha1/namespaces/tinkerbell/workflows/"
)

func TestSelectValueShapes(t *testing.T) {
	cases := map[string]string{
		`"provision"`: "provision",
		`{"value":"provision","label":"Provision"}`: "provision",
		`null`: "",
		``:     "",
	}
	for in, want := range cases {
		if got := selectValue(json.RawMessage(in)); got != want {
			t.Errorf("selectValue(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestParseDeviceBMCAddress(t *testing.T) {
	raw, _ := json.Marshal(device("riptide", "active", "none", nil))
	d, err := parseDevice(raw)
	if err != nil {
		t.Fatal(err)
	}
	if d.BMCAddress != "10.3.0.12" || d.Address != "10.3.0.12" || d.Class != "worker-g5" || d.Status != "active" {
		t.Fatalf("parsed %+v", d)
	}
	rf := device("swell", "planned", "none", map[string]any{"bmc_type": map[string]any{"value": "redfish"}})
	rf["oob_ip"] = map[string]any{"address": "10.4.0.5/24"}
	raw, _ = json.Marshal(rf)
	d, _ = parseDevice(raw)
	if d.BMCType != "redfish" || d.BMCAddress != "10.4.0.5" {
		t.Fatalf("redfish parsed %+v", d)
	}
	none := device("shale", "active", "none", map[string]any{"bmc_type": "none"})
	raw, _ = json.Marshal(none)
	d, _ = parseDevice(raw)
	if d.BMCAddress != "" {
		t.Fatalf("none has address %q", d.BMCAddress)
	}
}

func TestNextStatus(t *testing.T) {
	for _, c := range []struct {
		action, current, want string
	}{
		{"provision", "active", "staged"},
		{"provision", "failed", "staged"},
		{"provision", "planned", ""},
		{"provision", "staged", ""},
		{"wipe", "active", "staged"},
		{"wipe", "planned", ""},
		{"attest", "active", ""},
		{"attest", "planned", ""},
		{ActionRetire, "decommissioning", ""},
	} {
		if got := NextStatus(c.action, c.current); got != c.want {
			t.Errorf("NextStatus(%s, %s) = %q, want %q", c.action, c.current, got, c.want)
		}
	}
}

func TestPlannedDeviceStaysPlannedThroughProvision(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("swell", "planned", "provision", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "provision-swell-") {
		t.Fatalf("workflows %v", names)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("patches %v", nb.patches)
	}
	p := nb.patches[0]
	if _, has := p["status"]; has {
		t.Errorf("a planned device's status was written: %v", p)
	}
	cf := p["custom_fields"].(map[string]any)
	if cf["desired_action"] != "none" || cf["last_workflow"] != names[0] {
		t.Errorf("patch %v", p)
	}
}

func TestSkipsAttest(t *testing.T) {
	for _, c := range []struct {
		d    Device
		want bool
	}{
		{Device{TPM: "2.0"}, false},
		{Device{TPM: ""}, false},
		{Device{TPM: "1.2"}, true},
		{Device{TPM: "", Class: "worker-g2"}, true},
	} {
		if got := SkipsAttest(c.d); got != c.want {
			t.Errorf("SkipsAttest(%+v) = %v", c.d, got)
		}
	}
}

func TestPagingFollowsNext(t *testing.T) {
	devices := []map[string]any{}
	for i := 0; i < 5; i++ {
		d := device(fmt.Sprintf("node%d", i), "active", "none", nil)
		d["id"] = 100 + i
		devices = append(devices, d)
	}
	nb := &fakeNetBox{devices: devices, pageSize: 2}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	got, err := r.NetBox.Devices(context.Background(), "folly")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 || nb.pages != 3 {
		t.Fatalf("%d devices over %d pages", len(got), nb.pages)
	}
}

func TestProvisionStartsOneWorkflow(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "provision", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	hw := kube.get(hwPath)
	if hw == nil {
		t.Fatal("no Hardware applied")
	}
	spec := hw["spec"].(map[string]any)
	iface := spec["interfaces"].([]any)[0].(map[string]any)
	if mac := iface["dhcp"].(map[string]any)["mac"]; mac != "38:22:e2:2d:96:44" {
		t.Errorf("mac %v", mac)
	}
	contents := iface["netboot"].(map[string]any)["ipxe"].(map[string]any)["contents"].(string)
	if !strings.Contains(contents, "chain --autofree http://10.9.0.11/hookos.efi console=tty0") {
		t.Errorf("ipxe %q", contents)
	}
	if spec["bmcRef"] == nil {
		t.Error("no bmcRef")
	}
	m := kube.get(mPath)
	if m == nil {
		t.Fatal("no Machine applied")
	}
	conn := m["spec"].(map[string]any)["connection"].(map[string]any)
	if conn["host"] != "10.3.0.12" || conn["authSecretRef"].(map[string]any)["name"] != "bmc-amt" {
		t.Errorf("connection %v", conn)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "provision-riptide-") {
		t.Fatalf("workflows %v", names)
	}
	wfName := names[0]
	wf := kube.get(wfBase + wfName)
	hm := wf["spec"].(map[string]any)["hardwareMap"].(map[string]any)
	if hm["wipe"] != "true" || hm["attest"] != "true" || hm["retire"] != "false" || hm["attest_url"] != "http://10.9.0.14/attest" || hm["ntp_server"] != "10.9.0.14" {
		t.Errorf("hardwareMap %v", hm)
	}
	boot := wf["spec"].(map[string]any)["bootOptions"].(map[string]any)
	if boot["bootMode"] != "netboot" || boot["toggleAllowNetboot"] != true {
		t.Errorf("bootOptions %v", boot)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("patches %v", nb.patches)
	}
	p := nb.patches[0]
	cf := p["custom_fields"].(map[string]any)
	if p["status"] != "staged" || cf["desired_action"] != "none" || cf["last_workflow"] != wfName {
		t.Errorf("patch %v", p)
	}
	if len(nb.journals) != 1 {
		t.Errorf("journals %v", nb.journals)
	}

	// The webhook rings on the controller's own write. NetBox now shows the reset field.
	nb.set("desired_action", "none")
	nb.set("last_workflow", wfName)
	nb.set("status", "staged")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("a second pass wrote again: %v", nb.patches)
	}
	if n := kube.workflows(); len(n) != 1 {
		t.Fatalf("%v after two passes", n)
	}

	// The owner sets desired_action again mid-run: no second run.
	nb.set("desired_action", "attest")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := kube.workflows(); len(n) != 1 || n[0] != wfName {
		t.Fatalf("a second run started mid-run: %v", n)
	}
	last := nb.patches[len(nb.patches)-1]
	if last["custom_fields"].(map[string]any)["desired_action"] != "none" || last["custom_fields"].(map[string]any)["last_workflow"] != wfName {
		t.Errorf("mid-run patch %v", last)
	}

	// The run finishes; a new action deletes the finished run and starts one.
	nb.set("desired_action", "attest")
	nb.set("status", "active")
	kube.setState(wfName, "SUCCESS")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	n := kube.workflows()
	if len(n) != 1 || !strings.HasPrefix(n[0], "attest-riptide-") {
		t.Fatalf("after the finished run: %v", n)
	}
	last = nb.patches[len(nb.patches)-1]
	if _, has := last["status"]; has {
		t.Errorf("attest changed the status: %v", last)
	}
}

func TestFailedNetBoxWriteStartsNoSecondWorkflow(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "provision", nil)}, ifaces: riptideIfaces(), failPatch: true}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()

	for i := 0; i < 3; i++ {
		if err := r.Reconcile(context.Background()); err == nil {
			t.Fatal("a failed PATCH was not reported")
		}
	}
	names := kube.workflows()
	if len(names) != 1 {
		t.Fatalf("workflows after three failing passes: %v", names)
	}
	nb.mu.Lock()
	nb.failPatch = false
	nb.mu.Unlock()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := kube.workflows(); len(n) != 1 || n[0] != names[0] {
		t.Fatalf("the recovery pass changed the run: %v", n)
	}
	if len(nb.patches) != 1 || nb.patches[0]["custom_fields"].(map[string]any)["last_workflow"] != names[0] {
		t.Fatalf("recovery patch %v", nb.patches)
	}
	if r.Metrics.WorkflowsCreated.Load() != 1 {
		t.Errorf("created %d", r.Metrics.WorkflowsCreated.Load())
	}
}

func TestWipeSkipsAttestOnTPM12AndManualBootWithoutBMC(t *testing.T) {
	d := device("shale", "active", "wipe", map[string]any{"tpm_version": "1.2", "bmc_type": "none"})
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: []map[string]any{{
		"id": 1, "device": map[string]any{"id": 7}, "primary_mac_address": map[string]any{"mac_address": "ec:8e:b5:72:35:24"},
	}}}
	foreign := Object{"metadata": map[string]any{"name": "shale", "labels": map[string]any{"kustomize.toolkit.fluxcd.io/name": "tinkerbell"}}}
	kube := &fakeKube{objects: map[string]Object{strings.Replace(mPath, "riptide", "shale", 1): foreign}}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "wipe-shale-") {
		t.Fatalf("workflows %v", names)
	}
	wf := kube.get(wfBase + names[0])
	hm := wf["spec"].(map[string]any)["hardwareMap"].(map[string]any)
	if hm["attest"] != "false" || hm["wipe"] != "true" {
		t.Errorf("hardwareMap %v", hm)
	}
	if _, has := wf["spec"].(map[string]any)["bootOptions"].(map[string]any)["bootMode"]; has {
		t.Error("a device without a BMC got a bootMode")
	}
	if kube.get(strings.Replace(mPath, "riptide", "shale", 1)) == nil {
		t.Error("a Machine the controller does not own was deleted")
	}
}

func TestRetirement(t *testing.T) {
	old := testNow.Add(-2 * 24 * time.Hour).UTC().Format(time.RFC3339)
	d := device("riptide", "decommissioning", "none", map[string]any{"last_workflow": "wipe-riptide-1"})
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: riptideIfaces()}
	// An earlier owner-asked wipe succeeded within the TTL. It is no retirement.
	kube := &fakeKube{objects: map[string]Object{wfBase + "wipe-riptide-1": workflowObject("wipe-riptide-1", "riptide", "wipe", old, "SUCCESS")}}
	r, done := newTest(t, nb, kube)
	defer done()

	// First pass: a retire run starts, status stays, the finished wipe is deleted.
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	names := kube.workflows()
	if len(names) != 1 || !strings.HasPrefix(names[0], "retire-riptide-") {
		t.Fatalf("workflows %v", names)
	}
	wfName := names[0]
	hm := kube.get(wfBase + wfName)["spec"].(map[string]any)["hardwareMap"].(map[string]any)
	if hm["retire"] != "true" || hm["wipe"] != "true" || hm["attest"] != "false" {
		t.Errorf("hardwareMap %v", hm)
	}
	if _, has := nb.patches[0]["status"]; has {
		t.Errorf("status changed on the retire start: %v", nb.patches[0])
	}

	// Second pass: the run goes; nothing happens.
	nb.set("last_workflow", wfName)
	kube.setState(wfName, "RUNNING")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("patched during the run: %v", nb.patches)
	}

	// Third pass: success → offline, objects gone.
	kube.setState(wfName, "SUCCESS")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	last := nb.patches[len(nb.patches)-1]
	if last["status"] != "offline" {
		t.Errorf("final patch %v", last)
	}
	if kube.get(hwPath) != nil || kube.get(mPath) != nil {
		t.Error("Hardware or Machine survived the retirement")
	}
}

func TestLeavingDecommissioningAbandonsTheRetirement(t *testing.T) {
	d := device("riptide", "decommissioning", "none", nil)
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	wfName := kube.workflows()[0]
	nb.set("last_workflow", wfName)
	nb.set("status", "active")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := kube.workflows(); len(n) != 0 {
		t.Fatalf("the retirement survived the status change: %v", n)
	}
}

func TestFailedRetirementJournalsOnce(t *testing.T) {
	d := device("riptide", "decommissioning", "none", map[string]any{"last_workflow": "retire-riptide-5"})
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + "retire-riptide-5": workflowObject("retire-riptide-5", "riptide", "retire", testNow.UTC().Format(time.RFC3339), "FAILED")}}
	r, done := newTest(t, nb, kube)
	defer done()
	for i := 0; i < 3; i++ {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(nb.journals) != 1 || len(nb.patches) != 0 {
		t.Fatalf("journals %d patches %d", len(nb.journals), len(nb.patches))
	}
	if n := kube.workflows(); len(n) != 1 {
		t.Fatalf("a failed retirement was rerun: %v", n)
	}
}

func TestOfflineDevicesLoseTheirObjects(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{
		strings.Replace(hwPath, "riptide", "gone", 1): {
			"metadata": map[string]any{"name": "gone", "labels": map[string]any{ManagedLabel: FieldManager}},
		},
	}}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if kube.get(strings.Replace(hwPath, "riptide", "gone", 1)) != nil {
		t.Error("a Hardware with no device survived")
	}
}

func TestPrune(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", nil)}}
	old := testNow.Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339)
	fresh := testNow.Add(-time.Hour).UTC().Format(time.RFC3339)
	kube := &fakeKube{objects: map[string]Object{
		wfBase + "old":   workflowObject("old", "other", "attest", old, "SUCCESS"),
		wfBase + "fresh": workflowObject("fresh", "other", "attest", fresh, "SUCCESS"),
	}}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if kube.get(wfBase+"old") != nil || kube.get(wfBase+"fresh") == nil {
		t.Error("prune kept the old Workflow or deleted the fresh one")
	}
}

func TestWebhookSignature(t *testing.T) {
	trigger := make(chan string, 1)
	h := &Webhook{Secret: []byte("s3"), Trigger: trigger, Metrics: NewMetrics()}
	body := `{"event":"updated","model":"device","data":{"id":7}}`
	sign := func(secret string) string {
		m := hmac.New(sha512.New, []byte(secret))
		m.Write([]byte(body))
		return hex.EncodeToString(m.Sum(nil))
	}
	for _, c := range []struct {
		sig  string
		want int
	}{{sign("s3"), http.StatusAccepted}, {sign("other"), http.StatusUnauthorized}, {"", http.StatusUnauthorized}} {
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
		req.Header.Set("X-Hook-Signature", c.sig)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("signature %q: %d, want %d", c.sig, rec.Code, c.want)
		}
	}
	select {
	case <-trigger:
	default:
		t.Error("the good signature queued no reconcile")
	}
	// A second good call with the channel full is still accepted.
	trigger <- "x"
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	req.Header.Set("X-Hook-Signature", sign("s3"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Errorf("full trigger: %d", rec.Code)
	}
	if fmt.Sprint(h.Metrics.WebhookAccepted.Load()) != "2" {
		t.Errorf("accepted %d", h.Metrics.WebhookAccepted.Load())
	}
}
