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
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeNetBox serves a device list and records the patches and journal
// entries it receives.
type fakeNetBox struct {
	mu       sync.Mutex
	devices  []map[string]any
	ifaces   []map[string]any
	patches  []map[string]any
	journals []map[string]any
}

func (f *fakeNetBox) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/dcim/devices/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"count": len(f.devices), "results": f.devices})
	})
	mux.HandleFunc("GET /api/dcim/interfaces/", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"count": len(f.ifaces), "results": f.ifaces})
	})
	mux.HandleFunc("PATCH /api/dcim/devices/{id}/", func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		p["id"] = r.PathValue("id")
		f.mu.Lock()
		f.patches = append(f.patches, p)
		f.mu.Unlock()
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

// fakeKube stores objects by path.
type fakeKube struct {
	mu      sync.Mutex
	objects map[string]Object
	log     []string
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
			var items []Object
			for p, o := range f.objects {
				if strings.HasPrefix(p, r.URL.Path+"/") {
					items = append(items, o)
				}
			}
			if items == nil && !strings.HasSuffix(r.URL.Path, "s") && !strings.HasSuffix(r.URL.Path, "hardware") {
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
	r := &Reconciler{
		Config:  cfg,
		NetBox:  &NetBox{URL: nbs.URL, Token: "nbt_x.y", Client: nbs.Client()},
		Kube:    &Kube{Server: ks.URL, Namespace: "tinkerbell", Client: ks.Client()},
		Metrics: NewMetrics(),
		Now:     func() time.Time { return time.Unix(1_700_000_000, 0) },
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

func TestProvisionStartsOneWorkflow(t *testing.T) {
	nb := &fakeNetBox{
		devices: []map[string]any{device("riptide", "active", "provision", nil)},
		ifaces: []map[string]any{{
			"id": 3, "device": map[string]any{"id": 7},
			"primary_mac_address": map[string]any{"mac_address": "38:22:E2:2D:96:44"},
		}},
	}
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
	wfName := "provision-riptide-1700000000"
	wf := kube.get(wfBase + wfName)
	if wf == nil {
		t.Fatal("no Workflow created")
	}
	hm := wf["spec"].(map[string]any)["hardwareMap"].(map[string]any)
	if hm["wipe"] != "true" || hm["attest"] != "true" || hm["attest_url"] != "http://10.9.0.14/attest" || hm["ntp_server"] != "10.9.0.14" {
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
	nb.mu.Lock()
	nb.devices[0]["custom_fields"].(map[string]any)["desired_action"] = "none"
	nb.devices[0]["custom_fields"].(map[string]any)["last_workflow"] = wfName
	nb.devices[0]["status"] = "staged"
	nb.mu.Unlock()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("a second pass wrote again: %v", nb.patches)
	}
	var workflows int
	for p := range kube.objects {
		if strings.HasPrefix(p, wfBase) {
			workflows++
		}
	}
	if workflows != 1 {
		t.Fatalf("%d workflows after two passes", workflows)
	}
}

func TestWipeSkipsAttestOnTPM12AndManualBootWithoutBMC(t *testing.T) {
	d := device("shale", "active", "wipe", map[string]any{"tpm_version": "1.2", "bmc_type": "none"})
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: []map[string]any{{
		"id": 1, "device": map[string]any{"id": 7}, "primary_mac_address": map[string]any{"mac_address": "ec:8e:b5:72:35:24"},
	}}}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	wf := kube.get(wfBase + "wipe-shale-1700000000")
	if wf == nil {
		t.Fatal("no Workflow")
	}
	hm := wf["spec"].(map[string]any)["hardwareMap"].(map[string]any)
	if hm["attest"] != "false" || hm["wipe"] != "true" {
		t.Errorf("hardwareMap %v", hm)
	}
	if _, has := wf["spec"].(map[string]any)["bootOptions"].(map[string]any)["bootMode"]; has {
		t.Error("a device without a BMC got a bootMode")
	}
	if kube.get(strings.Replace(mPath, "riptide", "shale", 1)) != nil {
		t.Error("a device without a BMC got a Machine")
	}
}

func TestRetirement(t *testing.T) {
	d := device("riptide", "decommissioning", "none", nil)
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: []map[string]any{{
		"id": 1, "device": map[string]any{"id": 7}, "primary_mac_address": map[string]any{"mac_address": "38:22:e2:2d:96:44"},
	}}}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()

	// First pass: a wipe starts, status stays.
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	wfName := "wipe-riptide-1700000000"
	if kube.get(wfBase+wfName) == nil {
		t.Fatal("no wipe Workflow")
	}
	if _, has := nb.patches[0]["status"]; has {
		t.Errorf("status changed on the wipe start: %v", nb.patches[0])
	}

	// Second pass: the wipe runs; nothing happens.
	nb.mu.Lock()
	nb.devices[0]["custom_fields"].(map[string]any)["last_workflow"] = wfName
	nb.mu.Unlock()
	kube.mu.Lock()
	kube.objects[wfBase+wfName]["status"] = map[string]any{"state": "RUNNING"}
	kube.mu.Unlock()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("patched during the run: %v", nb.patches)
	}

	// Third pass: success → offline, objects gone.
	kube.mu.Lock()
	kube.objects[wfBase+wfName]["status"] = map[string]any{"state": "SUCCESS"}
	kube.mu.Unlock()
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

func TestOfflineDevicesLoseTheirObjects(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", nil)}, ifaces: []map[string]any{{
		"id": 1, "device": map[string]any{"id": 7}, "primary_mac_address": map[string]any{"mac_address": "38:22:e2:2d:96:44"},
	}}}
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
	old := time.Unix(1_700_000_000, 0).Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339)
	fresh := time.Unix(1_700_000_000, 0).Add(-time.Hour).UTC().Format(time.RFC3339)
	kube := &fakeKube{objects: map[string]Object{
		wfBase + "old":   {"metadata": map[string]any{"name": "old", "creationTimestamp": old, "labels": map[string]any{ManagedLabel: FieldManager}}},
		wfBase + "fresh": {"metadata": map[string]any{"name": "fresh", "creationTimestamp": fresh, "labels": map[string]any{ManagedLabel: FieldManager}}},
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
