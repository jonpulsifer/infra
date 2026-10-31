package fleet

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

	// apply makes a device PATCH change the stored device, as NetBox does.
	apply    bool
	failMACs bool
	macs     []map[string]any
	switches []map[string]any
	deleted  []string
	nextID   int
}

func (f *fakeNetBox) id() int {
	if f.nextID == 0 {
		f.nextID = 1000
	}
	f.nextID++
	return f.nextID
}

func (f *fakeNetBox) ifaceByID(id int) map[string]any {
	for _, i := range f.ifaces {
		if fmt.Sprint(i["id"]) == fmt.Sprint(id) {
			return i
		}
	}
	return nil
}

// applyPatch merges a device PATCH into the stored device.
func (f *fakeNetBox) applyPatch(id string, p map[string]any) {
	for _, d := range f.devices {
		if fmt.Sprint(d["id"]) != id {
			continue
		}
		for k, v := range p {
			switch k {
			case "id":
			case "custom_fields":
				for ck, cv := range v.(map[string]any) {
					d["custom_fields"].(map[string]any)[ck] = cv
				}
			case "status":
				d["status"] = map[string]any{"value": v}
			default:
				d[k] = v
			}
		}
	}
}

func (f *fakeNetBox) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/dcim/devices/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.pages++
		if r.URL.Query().Get("role") == "switch" {
			json.NewEncoder(w).Encode(map[string]any{"count": len(f.switches), "next": nil, "results": f.switches})
			return
		}
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
		f.mu.Lock()
		defer f.mu.Unlock()
		q := r.URL.Query()
		results := []map[string]any{}
		for _, i := range f.ifaces {
			if ids := q["device_id"]; len(ids) > 0 {
				dev := fmt.Sprint(i["device"].(map[string]any)["id"])
				found := false
				for _, id := range ids {
					found = found || id == dev
				}
				if !found {
					continue
				}
			}
			if n := q.Get("name"); n != "" && i["name"] != n {
				continue
			}
			if q.Get("type__n") == "virtual" && i["type"] == "virtual" {
				continue
			}
			results = append(results, i)
		}
		json.NewEncoder(w).Encode(map[string]any{"count": len(results), "next": nil, "results": results})
	})
	mux.HandleFunc("GET /api/dcim/interfaces/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		id, _ := strconv.Atoi(r.PathValue("id"))
		i := f.ifaceByID(id)
		if i == nil {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(i)
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
		if f.apply {
			f.applyPatch(r.PathValue("id"), p)
		}
		p["id"] = r.PathValue("id")
		f.patches = append(f.patches, p)
		w.Write([]byte("{}"))
	})
	mux.HandleFunc("DELETE /api/dcim/devices/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for i, d := range f.devices {
			if fmt.Sprint(d["id"]) == r.PathValue("id") {
				f.deleted = append(f.deleted, d["name"].(string))
				f.devices = append(f.devices[:i], f.devices[i+1:]...)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("GET /api/dcim/mac-addresses/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.failMACs {
			http.Error(w, `{"detail":"down"}`, http.StatusBadGateway)
			return
		}
		results := []map[string]any{}
		for _, m := range f.macs {
			if strings.EqualFold(m["mac_address"].(string), r.URL.Query().Get("mac_address")) {
				results = append(results, m)
			}
		}
		json.NewEncoder(w).Encode(map[string]any{"count": len(results), "next": nil, "results": results})
	})
	mux.HandleFunc("POST /api/dcim/interfaces/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var i map[string]any
		json.NewDecoder(r.Body).Decode(&i)
		i["id"] = f.id()
		i["device"] = map[string]any{"id": i["device"]}
		f.ifaces = append(f.ifaces, i)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(i)
	})
	mux.HandleFunc("PATCH /api/dcim/interfaces/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		id, _ := strconv.Atoi(r.PathValue("id"))
		i := f.ifaceByID(id)
		for _, m := range f.macs {
			if fmt.Sprint(m["id"]) == fmt.Sprint(p["primary_mac_address"]) {
				i["primary_mac_address"] = map[string]any{"id": m["id"], "mac_address": m["mac_address"]}
			}
		}
		json.NewEncoder(w).Encode(i)
	})
	mux.HandleFunc("POST /api/dcim/mac-addresses/", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		var m map[string]any
		json.NewDecoder(r.Body).Decode(&m)
		m["id"] = f.id()
		f.macs = append(f.macs, m)
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(m)
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
	// racing replaces an object just before its delete, as a write that lands
	// between fleetd's read and its delete.
	racing map[string]Object
	log    []string
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
			var o Object
			json.Unmarshal(body, &o)
			old, exists := f.objects[r.URL.Path]
			switch ct := r.Header.Get("Content-Type"); ct {
			case "application/apply-patch+yaml":
				// Annotations another field manager wrote outlive an apply
				// that does not set them.
				if exists {
					kept, _ := old.metadata()["annotations"].(map[string]any)
					applied, _ := o.metadata()["annotations"].(map[string]any)
					for k, v := range kept {
						if _, set := applied[k]; !set {
							if applied == nil {
								applied = map[string]any{}
								o.metadata()["annotations"] = applied
							}
							applied[k] = v
						}
					}
				}
				f.objects[r.URL.Path] = o
			case "application/merge-patch+json":
				if !exists {
					http.NotFound(w, r)
					return
				}
				a, _ := old.metadata()["annotations"].(map[string]any)
				if a == nil {
					a = map[string]any{}
					old.metadata()["annotations"] = a
				}
				for k, v := range o.metadata()["annotations"].(map[string]any) {
					if v == nil {
						delete(a, k)
					} else {
						a[k] = v
					}
				}
			default:
				http.Error(w, "content type "+ct, http.StatusUnsupportedMediaType)
				return
			}
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
			if o, ok := f.racing[r.URL.Path]; ok {
				f.objects[r.URL.Path] = o
				delete(f.racing, r.URL.Path)
			}
			o, ok := f.objects[r.URL.Path]
			if !ok {
				http.NotFound(w, r)
				return
			}
			var opts struct {
				Preconditions *struct {
					ResourceVersion string `json:"resourceVersion"`
				} `json:"preconditions"`
			}
			json.Unmarshal(body, &opts)
			if opts.Preconditions != nil && opts.Preconditions.ResourceVersion != o.ResourceVersion() {
				http.Error(w, "the object has been modified", http.StatusConflict)
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
		"install_disk":        "/dev/nvme0n1",
		"install_disk_serial": "30DF7020FGKL",
		"talos_class":         map[string]any{"value": "worker-g5", "label": "worker-g5"},
		"tpm_version":         "2.0",
		"bmc_type":            "amt",
		"desired_action":      action,
		"last_workflow":       nil,
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
		Site: "folly", Namespace: "tinkerbell", Classes: testClasses,
		HookOSURL: "http://10.9.0.11/hookos.efi", HookOSCmdline: "console=tty0",
		Interval: time.Minute, WorkflowTTL: 7 * 24 * time.Hour,
		BMCSecrets: map[string]string{"amt": "bmc-amt"},
		AMTPort:    16992,
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
	oob := device("swell", "planned", "none", map[string]any{"bmc_type": map[string]any{"value": "amt"}})
	oob["oob_ip"] = map[string]any{"address": "10.4.0.5/24"}
	raw, _ = json.Marshal(oob)
	d, _ = parseDevice(raw)
	if d.BMCType != "amt" || d.BMCAddress != "10.4.0.5" {
		t.Fatalf("oob_ip parsed %+v", d)
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
		{"provision", "active", "planned"},
		{"provision", "failed", "planned"},
		{"provision", "planned", ""},
		{"wipe", "active", "planned"},
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

func machineHost(m Object) any {
	return m["spec"].(map[string]any)["connection"].(map[string]any)["host"]
}

// A planned AMT device's Machine dials its own declared address, so a
// provision powers it on through AMT, and the run pins nothing.
func TestPlannedAMTDeviceIsPoweredAtItsDeclaredAddress(t *testing.T) {
	swellMachine := strings.Replace(mPath, "riptide", "swell", 1)
	swellHardware := strings.Replace(hwPath, "riptide", "swell", 1)
	nb := &fakeNetBox{devices: []map[string]any{device("swell", "planned", "provision", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	m := kube.get(swellMachine)
	if m == nil || machineHost(m) != "10.3.0.12" {
		t.Fatalf("Machine %v", m)
	}
	if _, has := kube.get(swellHardware)["spec"].(map[string]any)["bmcRef"]; !has {
		t.Error("the Hardware names no Machine")
	}
	wf := kube.get(wfBase + kube.workflows()[0])
	if boot := wf["spec"].(map[string]any)["bootOptions"].(map[string]any); boot["bootMode"] != "netboot" {
		t.Errorf("bootOptions %v", boot)
	}
	if _, has := wf.metadata()["annotations"]; has {
		t.Errorf("the run carries annotations: %v", wf.metadata()["annotations"])
	}
	if len(nb.journals) != 1 || strings.Contains(nb.journals[0]["comments"].(string), "by hand") {
		t.Errorf("journals %v", nb.journals)
	}
}

// A planned device with no address yet has nothing for Rufio to dial: it
// boots by hand until NetBox gives it one.
func TestPlannedDeviceWithoutAnAddressBootsByHand(t *testing.T) {
	d := device("swell", "planned", "provision", nil)
	d["primary_ip4"] = nil
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if m := kube.get(strings.Replace(mPath, "riptide", "swell", 1)); m != nil {
		t.Errorf("Machine %v", m)
	}
	boot := kube.get(wfBase + kube.workflows()[0])["spec"].(map[string]any)["bootOptions"].(map[string]any)
	if _, has := boot["bootMode"]; has || boot["toggleAllowNetboot"] != false {
		t.Errorf("bootOptions %v", boot)
	}
	if len(nb.journals) != 1 || !strings.Contains(nb.journals[0]["comments"].(string), "power the machine on by hand") {
		t.Errorf("journals %v", nb.journals)
	}
}

func TestPlannedDeviceWithOOBIPGetsItsMachine(t *testing.T) {
	d := device("surge", "planned", "provision", nil)
	d["oob_ip"] = map[string]any{"address": "10.4.0.6/24"}
	nb := &fakeNetBox{devices: []map[string]any{d}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	m := kube.get(strings.Replace(mPath, "riptide", "surge", 1))
	if m == nil || machineHost(m) != "10.4.0.6" {
		t.Fatalf("Machine %v", m)
	}
	boot := kube.get(wfBase + kube.workflows()[0])["spec"].(map[string]any)["bootOptions"].(map[string]any)
	if boot["bootMode"] != "netboot" {
		t.Errorf("bootOptions %v", boot)
	}
}

// fakeCluster records the cordons fleetd sends to the cluster's API.
type fakeCluster struct {
	mu      sync.Mutex
	patches []string
	auth    []string
	missing map[string]bool
}

func (f *fakeCluster) server(t *testing.T) *Cluster {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		node, ok := strings.CutPrefix(r.URL.Path, "/api/v1/nodes/")
		if r.Method != http.MethodPatch || !ok || r.Header.Get("Content-Type") != "application/merge-patch+json" {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		if f.missing[node] {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f.patches = append(f.patches, node+" "+string(body))
		f.auth = append(f.auth, r.Header.Get("Authorization"))
		w.Write([]byte("{}"))
	}))
	t.Cleanup(s.Close)
	return &Cluster{Server: s.URL, Token: "sa-token", Client: s.Client()}
}

// A quarantined node is cordoned on every pass; a control plane's failed
// check, a pass and an unknown node are not.
func TestQuarantinedNodeIsCordoned(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{
		device("riptide", "active", "none", map[string]any{"attest_verdict": "quarantined: pcr: PCR 7 differs"}),
		mergeID(device("optiplex", "active", "none", map[string]any{"attest_verdict": "failed-no-quarantine: pcr", "talos_class": "controlplane"}), 8),
		mergeID(device("shale", "active", "none", map[string]any{"attest_verdict": "attested"}), 9),
		mergeID(device("swell", "planned", "none", map[string]any{"attest_verdict": "quarantined: ek"}), 10),
	}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	fc := &fakeCluster{missing: map[string]bool{"swell": true}}
	r.Cluster = fc.server(t)
	for range 2 {
		if err := r.Reconcile(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	want := `riptide {"spec":{"unschedulable":true}}`
	if len(fc.patches) != 2 || fc.patches[0] != want || fc.patches[1] != want {
		t.Fatalf("cordons %v", fc.patches)
	}
	if fc.auth[0] != "Bearer sa-token" {
		t.Errorf("Authorization %q", fc.auth[0])
	}
	cordoned := 0
	for _, j := range nb.journals {
		if strings.Contains(j["comments"].(string), "cordoned the node") {
			cordoned++
		}
	}
	if cordoned != 1 {
		t.Errorf("%d cordon journal entries, want one: %v", cordoned, nb.journals)
	}
}

// A control plane is never cordoned, even with a quarantined verdict: by
// the controlplane class, or by a class the class inputs render as one.
func TestControlPlaneIsNeverCordoned(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{
		device("optiplex", "active", "none", map[string]any{"attest_verdict": "quarantined: pcr", "talos_class": "controlplane"}),
		mergeID(device("bigcp", "active", "none", map[string]any{"attest_verdict": "quarantined: pcr", "talos_class": "controlplane-big"}), 8),
	}, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	r.Config.ControlPlaneClasses = map[string]bool{"controlplane-big": true}
	fc := &fakeCluster{}
	r.Cluster = fc.server(t)
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(fc.patches) != 0 {
		t.Fatalf("a control plane was cordoned: %v", fc.patches)
	}
	r.Cluster = nil
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	for _, j := range nb.journals {
		if strings.Contains(j["comments"].(string), "cordon") {
			t.Errorf("a control plane's quarantine was journaled for a cordon: %v", j)
		}
	}
}

func TestQuarantineWithoutClusterCredentialsIsJournaled(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", map[string]any{"attest_verdict": "quarantined: pcr"})}, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	if err := r.Reconcile(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(nb.journals) != 1 || !strings.Contains(nb.journals[0]["comments"].(string), "cordon it by hand") {
		t.Errorf("journals %v", nb.journals)
	}
}

func mergeID(d map[string]any, id int) map[string]any {
	d["id"] = id
	return d
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
	if hm["wipe"] != "true" || hm["attest"] != "true" || hm["retire"] != "false" || hm["attest_url"] != nil || hm["ntp_server"] != nil {
		t.Errorf("hardwareMap %v", hm)
	}
	boot := wf["spec"].(map[string]any)["bootOptions"].(map[string]any)
	if boot["bootMode"] != "netboot" || boot["toggleAllowNetboot"] != false {
		t.Errorf("bootOptions %v", boot)
	}
	if len(nb.patches) != 1 {
		t.Fatalf("patches %v", nb.patches)
	}
	p := nb.patches[0]
	cf := p["custom_fields"].(map[string]any)
	if p["status"] != "planned" || cf["desired_action"] != "none" || cf["last_workflow"] != wfName {
		t.Errorf("patch %v", p)
	}
	if len(nb.journals) != 1 {
		t.Errorf("journals %v", nb.journals)
	}

	// The webhook rings on fleetd's own write. NetBox now shows the reset field.
	nb.set("desired_action", "none")
	nb.set("last_workflow", wfName)
	nb.set("status", "planned")
	nb.set("attest_verdict", "attested")
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

func hardwareInterface(t *testing.T, kube *fakeKube) map[string]any {
	t.Helper()
	hw := kube.get(hwPath)
	if hw == nil {
		t.Fatal("no Hardware applied")
	}
	return hw["spec"].(map[string]any)["interfaces"].([]any)[0].(map[string]any)
}

func assertNetboot(t *testing.T, kube *fakeKube, want bool, when string) {
	t.Helper()
	nb := hardwareInterface(t, kube)["netboot"].(map[string]any)
	if nb["allowPXE"] != want || nb["allowWorkflow"] != want {
		t.Errorf("%s: allowPXE %v, allowWorkflow %v, want both %v", when, nb["allowPXE"], nb["allowWorkflow"], want)
	}
	if _, has := nb["ipxe"].(map[string]any)["contents"]; !has {
		t.Errorf("%s: the netboot block lost its iPXE script: %v", when, nb)
	}
}

func handSetAllowPXE(kube *fakeKube, v bool) {
	kube.mu.Lock()
	defer kube.mu.Unlock()
	iface := kube.objects[hwPath]["spec"].(map[string]any)["interfaces"].([]any)[0].(map[string]any)
	iface["netboot"].(map[string]any)["allowPXE"] = v
}

// fleetd is the only writer of the netboot flags: they follow the
// device's unfinished Workflow, and every pass overwrites a hand-set value.
func TestHardwareNetbootFlagsFollowTheWorkflow(t *testing.T) {
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{}
	r, done := newTest(t, nb, kube)
	defer done()
	pass := func() {
		t.Helper()
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}

	pass()
	assertNetboot(t, kube, false, "no run")
	dhcp := hardwareInterface(t, kube)["dhcp"].(map[string]any)
	if dhcp["arch"] != "x86_64" || dhcp["uefi"] != true {
		t.Errorf("dhcp %v", dhcp)
	}

	nb.set("desired_action", "provision")
	pass()
	wfName := kube.workflows()[0]
	assertNetboot(t, kube, true, "a run just created")
	kube.mu.Lock()
	created := -1
	for i, l := range kube.log {
		if l == "POST "+strings.TrimSuffix(wfBase, "/") {
			created = i
		}
	}
	before := ""
	if created > 0 {
		before = kube.log[created-1]
	}
	kube.mu.Unlock()
	if before != "PATCH "+hwPath {
		t.Errorf("the Workflow was created before the Hardware allowed netboot: %q precedes it", before)
	}

	nb.set("desired_action", "none")
	nb.set("last_workflow", wfName)
	nb.set("status", "planned")
	nb.set("attest_verdict", "attested")
	for _, state := range []string{"STATE_PREPARING", "STATE_PENDING", "STATE_RUNNING", "STATE_POST"} {
		kube.setState(wfName, state)
		handSetAllowPXE(kube, false)
		pass()
		assertNetboot(t, kube, true, state)
	}

	kube.setState(wfName, "STATE_SUCCESS")
	pass()
	assertNetboot(t, kube, false, "after SUCCESS")

	handSetAllowPXE(kube, true)
	pass()
	assertNetboot(t, kube, false, "a hand-set allowPXE with no run")
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
	if hm["attest"] != "false" || hm["wipe"] != "true" || hm["retire"] != "false" {
		t.Errorf("hardwareMap %v", hm)
	}
	if _, has := wf["spec"].(map[string]any)["bootOptions"].(map[string]any)["bootMode"]; has {
		t.Error("a device without a BMC got a bootMode")
	}
	if kube.get(strings.Replace(mPath, "riptide", "shale", 1)) == nil {
		t.Error("a Machine fleetd does not own was deleted")
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
	assertNetboot(t, kube, true, "a retirement running")
	nb.set("last_workflow", wfName)
	nb.set("status", "active")
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := kube.workflows(); len(n) != 0 {
		t.Fatalf("the retirement survived the status change: %v", n)
	}
	assertNetboot(t, kube, false, "the retirement abandoned")
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

// The control plane the Talos root bootstraps etcd on is never provisioned or
// wiped: the run is refused once in its journal, and desired_action stays.
func TestBootstrapControlPlaneIsNeverWiped(t *testing.T) {
	for _, action := range []string{"provision", "wipe"} {
		t.Run(action, func(t *testing.T) {
			nb := &fakeNetBox{devices: []map[string]any{device("optiplex", "active", action, map[string]any{"talos_class": "controlplane"})}, ifaces: riptideIfaces()}
			kube := &fakeKube{}
			r, done := newTest(t, nb, kube)
			defer done()
			r.Config.Bootstrap = "10.3.0.12"
			for range 2 {
				if err := r.Reconcile(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			if n := kube.workflows(); len(n) != 0 {
				t.Fatalf("workflows %v", n)
			}
			for _, p := range nb.patches {
				if _, ok := p["status"]; ok {
					t.Errorf("status written: %v", p)
				}
				if cf, ok := p["custom_fields"].(map[string]any); ok && cf["desired_action"] != nil {
					t.Errorf("desired_action written: %v", p)
				}
			}
			if len(nb.journals) != 1 || !strings.Contains(nb.journals[0]["comments"].(string), action+" refused") {
				t.Errorf("journals %v", nb.journals)
			}
		})
	}
}

// A run that wipes waits for the install disk's serial, which the Template
// checks before it writes; an attest touches no disk and runs without one.
func TestARunThatWipesWaitsForTheDiskSerial(t *testing.T) {
	for _, c := range []struct {
		status, action string
		serial         any
		want           string
	}{
		{"active", "provision", nil, "provision waits: riptide declares no install_disk_serial"},
		{"active", "wipe", nil, "wipe waits: riptide declares no install_disk_serial"},
		{"decommissioning", "none", nil, "the retirement waits: riptide declares no install_disk_serial"},
		{"active", "provision", "30DF 7020", `install_disk_serial "30DF 7020" is malformed`},
		{"active", "attest", nil, ""},
	} {
		t.Run(c.status+"/"+c.action+"/"+fmt.Sprint(c.serial), func(t *testing.T) {
			nb := &fakeNetBox{devices: []map[string]any{device("riptide", c.status, c.action, map[string]any{"install_disk_serial": c.serial})}, ifaces: riptideIfaces()}
			kube := &fakeKube{}
			r, done := newTest(t, nb, kube)
			defer done()
			for range 2 {
				if err := r.Reconcile(t.Context()); err != nil {
					t.Fatal(err)
				}
			}
			if c.want == "" {
				if n := kube.workflows(); len(n) != 1 || !strings.HasPrefix(n[0], "attest-riptide-") {
					t.Fatalf("workflows %v", n)
				}
				return
			}
			if n := kube.workflows(); len(n) != 0 {
				t.Fatalf("workflows %v", n)
			}
			if kube.get(hwPath) == nil {
				t.Error("the Hardware went with the serial")
			}
			for _, p := range nb.patches {
				if cf, ok := p["custom_fields"].(map[string]any); ok && cf["desired_action"] != nil {
					t.Errorf("desired_action written: %v", p)
				}
			}
			if len(nb.journals) != 1 || !strings.Contains(nb.journals[0]["comments"].(string), c.want) {
				t.Errorf("journals %v", nb.journals)
			}
		})
	}
}

func TestInstallingTakesEveryAttestedVerdict(t *testing.T) {
	for _, c := range []struct {
		status, verdict string
		want            bool
	}{
		{"planned", "attested", true},
		{"planned", "failed-no-quarantine: policy", true},
		{"planned", "pending-approval", false},
		{"planned", "quarantined: ek-hash-mismatch", false},
		{"planned", "", false},
		{"active", "attested", false},
	} {
		if got := (Device{Status: c.status, Verdict: c.verdict}).Installing(); got != c.want {
			t.Errorf("%s %q: Installing() = %v", c.status, c.verdict, got)
		}
	}
}

func overdueWorkflow(name, stop, state, action string) Object {
	return agedWorkflow(name, 0, stop, state, action)
}

// agedWorkflow is a provision Workflow created age before testNow, at
// resourceVersion 1.
func agedWorkflow(name string, age time.Duration, stop, state, action string) Object {
	wf := workflowObject(name, "riptide", "provision", testNow.Add(-age).UTC().Format(time.RFC3339), state)
	wf.metadata()["resourceVersion"] = "1"
	st, _ := wf["status"].(map[string]any)
	if st == nil {
		st = map[string]any{}
		wf["status"] = st
	}
	if stop != "" {
		st["globalExecutionStop"] = stop
	}
	if action != "" {
		st["currentState"] = map[string]any{"actionName": action}
	}
	return wf
}

// A Workflow more than a pass past its deadline is annotated so that
// Tinkerbell's controller ends it. One with no usable deadline is deleted once
// its creation plus its global timeout is more than a pass past. Each is
// journaled once. A run inside its window, a finished one, a run whose
// deadline is still ahead however old it is, are left alone.
func TestOverdueWorkflowsAreNudged(t *testing.T) {
	at := func(d time.Duration) string { return testNow.Add(d).UTC().Format(time.RFC3339) }
	past := TemplateGlobalTimeout + 2*time.Minute
	short := agedWorkflow("short", 3*time.Minute, "", "STATE_RUNNING", "wipe-disk")
	short["status"].(map[string]any)["globalTimeout"] = 60
	long := agedWorkflow("long", past, "", "STATE_RUNNING", "wipe-disk")
	long["status"].(map[string]any)["globalTimeout"] = 7200
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "active", "none", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{
		wfBase + "late":     overdueWorkflow("late", at(-10*time.Minute), "STATE_RUNNING", "reboot"),
		wfBase + "recent":   overdueWorkflow("recent", at(-30*time.Second), "STATE_RUNNING", "install"),
		wfBase + "done":     overdueWorkflow("done", at(-10*time.Minute), "STATE_SUCCESS", "reboot"),
		wfBase + "slowboot": agedWorkflow("slowboot", past, at(5*time.Minute), "STATE_RUNNING", "install"),
		wfBase + "nodeadln": agedWorkflow("nodeadln", past, "", "STATE_RUNNING", "wipe-disk"),
		wfBase + "garbled":  agedWorkflow("garbled", past, "soon", "STATE_RUNNING", "wipe-disk"),
		wfBase + "pending":  agedWorkflow("pending", past, "", "STATE_PENDING", ""),
		wfBase + "fresh":    agedWorkflow("fresh", TemplateGlobalTimeout, "", "STATE_PENDING", ""),
		wfBase + "failed":   agedWorkflow("failed", past, "", "STATE_FAILED", "install"),
		wfBase + "short":    short,
		wfBase + "long":     long,
	}}
	r, done := newTest(t, nb, kube)
	defer done()
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	ended := map[string]bool{"nodeadln": true, "garbled": true, "pending": true, "short": true}
	for _, name := range []string{"late", "recent", "done", "slowboot", "nodeadln", "garbled", "pending", "fresh", "failed", "short", "long"} {
		wf := kube.get(wfBase + name)
		if gone := wf == nil; gone != ended[name] {
			t.Errorf("%s deleted = %v, want %v", name, gone, ended[name])
			continue
		}
		if wf == nil {
			continue
		}
		a, _ := wf.metadata()["annotations"].(map[string]any)
		_, got := a[OverdueAnnotation]
		if want := name == "late"; got != want {
			t.Errorf("%s annotated = %v, want %v", name, got, want)
		}
	}
	if len(nb.journals) != 1+len(ended) {
		t.Fatalf("journals %v", nb.journals)
	}
	for _, j := range nb.journals {
		c := j["comments"].(string)
		switch {
		case strings.Contains(c, "Workflow late "):
			if !strings.Contains(c, "reboot's report was lost") {
				t.Errorf("journal %q", c)
			}
		case strings.Contains(c, "never reported its first action"):
			if !strings.Contains(c, "fleetd deleted it") || !strings.Contains(c, "set desired_action") {
				t.Errorf("journal %q", c)
			}
		default:
			t.Errorf("journal %q", c)
		}
	}
	late := kube.get(wfBase + "late")
	if _, ok := late["spec"]; ok || late.State() != "STATE_RUNNING" {
		t.Errorf("the patch touched more than metadata: %v", late)
	}
}

// A run cut off before its first report is ended once, netboot goes off, no
// code is rendered for it, and the owner's next request starts a new run
// instead of adopting the old one.
func TestWorkflowWithoutDeadlineEndsAndANewRunStarts(t *testing.T) {
	const old = "provision-riptide-1"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "planned", "none", map[string]any{"last_workflow": old})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{
		wfBase + old: agedWorkflow(old, TemplateGlobalTimeout+2*time.Minute, "", "STATE_PENDING", ""),
	}}
	r, done := newTest(t, nb, kube)
	defer done()
	pass := func() {
		t.Helper()
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	pass()
	if kube.get(wfBase+old) != nil {
		t.Fatal("the Workflow without a deadline survived")
	}
	assertNetboot(t, kube, false, "the run ended")
	d, err := r.NetBox.BySerial(context.Background(), "folly", "MXL0172Q6L")
	if err != nil {
		t.Fatal(err)
	}
	if r.provisionRunning(context.Background(), d) {
		t.Error("Admit would render a code for the ended run")
	}
	pass()
	if len(nb.journals) != 1 {
		t.Fatalf("journals %v", nb.journals)
	}

	nb.set("desired_action", "provision")
	pass()
	names := kube.workflows()
	if len(names) != 1 || names[0] == old {
		t.Fatalf("workflows %v", names)
	}
	assertNetboot(t, kube, true, "the new run")
	cf := nb.patches[len(nb.patches)-1]["custom_fields"].(map[string]any)
	if cf["last_workflow"] != names[0] {
		t.Errorf("last_workflow %v, want %s", cf["last_workflow"], names[0])
	}
}

// A retirement without a deadline is left to decommissioning: deleting it
// would only start another at once.
func TestRetirementWithoutDeadlineIsLeftAlone(t *testing.T) {
	const name = "retire-riptide-1"
	wf := agedWorkflow(name, TemplateGlobalTimeout+2*time.Minute, "", "STATE_PENDING", "")
	wf.metadata()["labels"].(map[string]any)[ActionLabel] = ActionRetire
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "decommissioning", "none", map[string]any{"last_workflow": name})}, ifaces: riptideIfaces()}
	kube := &fakeKube{objects: map[string]Object{wfBase + name: wf}}
	r, done := newTest(t, nb, kube)
	defer done()
	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if names := kube.workflows(); len(names) != 1 || names[0] != name {
		t.Fatalf("workflows %v", names)
	}
	if len(nb.journals) != 0 {
		t.Errorf("journals %v", nb.journals)
	}
}

// A first report that lands between fleetd's read and its delete gives the
// Workflow its deadline and a new resourceVersion, so the delete's
// precondition fails and the run goes on.
func TestEndingSparesAWorkflowThatJustReported(t *testing.T) {
	past := TemplateGlobalTimeout + 2*time.Minute
	reported := agedWorkflow("racing", past, testNow.Add(20*time.Minute).UTC().Format(time.RFC3339), "STATE_RUNNING", "install")
	reported.metadata()["resourceVersion"] = "2"
	nb := &fakeNetBox{devices: []map[string]any{device("riptide", "planned", "none", nil)}, ifaces: riptideIfaces()}
	kube := &fakeKube{
		objects: map[string]Object{wfBase + "racing": agedWorkflow("racing", past, "", "STATE_RUNNING", "wipe-disk")},
		racing:  map[string]Object{wfBase + "racing": reported},
	}
	r, done := newTest(t, nb, kube)
	defer done()
	for range 2 {
		if err := r.Reconcile(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if wf := kube.get(wfBase + "racing"); wf == nil || wf.ResourceVersion() != "2" {
		t.Fatalf("the run that reported was deleted: %v", wf)
	}
	assertNetboot(t, kube, true, "the run goes on")
	if len(nb.journals) != 0 {
		t.Errorf("journals %v", nb.journals)
	}
}
