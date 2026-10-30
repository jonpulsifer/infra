package attest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// fakeNetBox is the part of NetBox's REST API the service uses, in memory:
// devices with custom fields, their interfaces and MACs, device types,
// manufacturers, one site, one role and a journal.
type fakeNetBox struct {
	mu         sync.Mutex
	t          *testing.T
	devices    map[int]*fakeDevice
	interfaces map[int]*fakeInterface
	types      map[int]string
	mfrs       map[int]string
	journal    []string
	next       int
	srv        *httptest.Server
	// failDevices answers every device lookup 500; failPatch every write;
	// failChanges every changelog read 403.
	failDevices bool
	failPatch   bool
	failChanges bool
	// changes is the changelog, oldest first. author is the user an edit
	// through add or set is logged as; the service's own writes are fleetd's.
	changes []fakeChange
	author  string
}

type fakeChange struct {
	ID       int
	DeviceID int
	User     string
	Time     time.Time
	Pre      map[string]any
	Post     map[string]any
}

// logChange appends a change of d's custom fields by user, from pre.
func (f *fakeNetBox) logChange(d *fakeDevice, pre map[string]any, user string) {
	f.next++
	f.changes = append(f.changes, fakeChange{ID: f.next, DeviceID: d.ID, User: user, Time: time.Now(), Pre: pre, Post: maps.Clone(d.CustomFields)})
}

type fakeDevice struct {
	ID           int
	Name         string
	Serial       string
	Status       string
	TypeID       int
	CustomFields map[string]any
	Updated      time.Time
	// Patches counts the service's writes: a pass makes two, at evidence
	// and at confirm, and a test waits for both before it edits the device.
	Patches int
}

type fakeInterface struct {
	ID       int
	DeviceID int
	Name     string
	MAC      string
	MACID    int
	// Extra are MACs assigned to the interface besides its primary, as
	// another anchor's write that has not set its primary yet leaves.
	Extra []string
}

func newFakeNetBox(t *testing.T) *fakeNetBox {
	f := &fakeNetBox{t: t, devices: map[int]*fakeDevice{}, interfaces: map[int]*fakeInterface{}, types: map[int]string{}, mfrs: map[int]string{}, next: 100, author: fakeTerraform}
	f.types[1] = "HP EliteDesk 800 G5 Desktop Mini"
	f.mfrs[1] = "HP"
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeNetBox) client() *NetBox {
	return &NetBox{URL: f.srv.URL, Token: "nbt_test", Client: f.srv.Client()}
}

// fakeTerraform is the user the fake logs Terraform's edits as.
const fakeTerraform = "terraform"

// add seeds a device with a MAC on eth0.
func (f *fakeNetBox) add(name, serial, status, mac string, fields map[string]any) *fakeDevice {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	d := &fakeDevice{ID: f.next, Name: name, Serial: serial, Status: status, TypeID: 1, CustomFields: map[string]any{}, Updated: time.Now()}
	for k, v := range fields {
		d.CustomFields[k] = v
	}
	f.devices[d.ID] = d
	f.logChange(d, nil, f.author)
	f.next++
	i := &fakeInterface{ID: f.next, DeviceID: d.ID, Name: "eno1", MAC: mac}
	if mac != "" {
		f.next++
		i.MACID = f.next
	}
	f.interfaces[i.ID] = i
	return d
}

// setFailing switches the fake's failure modes under the lock.
func (f *fakeNetBox) setFailing(devices, patch bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failDevices, f.failPatch = devices, patch
}

// count is how many devices the fake holds.
func (f *fakeNetBox) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.devices)
}

// bySerial is a snapshot of the device with serial, since the service's
// recorders write the store from their own goroutines.
func (f *fakeNetBox) bySerial(serial string) *fakeDevice {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.devices {
		if strings.EqualFold(d.Serial, serial) {
			c := *d
			c.CustomFields = map[string]any{}
			for k, v := range d.CustomFields {
				c.CustomFields[k] = v
			}
			return &c
		}
	}
	return nil
}

// set changes the device with serial under the lock, as the owner editing
// it in NetBox would.
func (f *fakeNetBox) set(serial string, change func(*fakeDevice)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.devices {
		if strings.EqualFold(d.Serial, serial) {
			pre := maps.Clone(d.CustomFields)
			change(d)
			d.Updated = time.Now()
			f.logChange(d, pre, f.author)
			return
		}
	}
	f.t.Fatalf("fake NetBox: no device with serial %s", serial)
}

func (f *fakeNetBox) deviceJSON(d *fakeDevice) map[string]any {
	return map[string]any{
		"id": d.ID, "name": d.Name, "serial": d.Serial,
		"status":        map[string]any{"value": d.Status, "label": d.Status},
		"site":          map[string]any{"id": 1, "slug": "folly"},
		"device_type":   map[string]any{"id": d.TypeID, "model": f.types[d.TypeID]},
		"last_updated":  d.Updated.UTC().Format(time.RFC3339Nano),
		"custom_fields": d.CustomFields,
	}
}

func (f *fakeNetBox) interfaceJSON(i *fakeInterface) map[string]any {
	out := map[string]any{"id": i.ID, "name": i.Name, "device": map[string]any{"id": i.DeviceID}, "primary_mac_address": nil}
	if i.MAC != "" {
		out["primary_mac_address"] = map[string]any{"id": i.MACID, "mac_address": strings.ToUpper(i.MAC)}
	}
	return out
}

func page(w http.ResponseWriter, results []any) {
	if results == nil {
		results = []any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": len(results), "results": results})
}

func (f *fakeNetBox) serve(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer nbt_") {
		http.Error(w, "no token", http.StatusForbidden)
		return
	}
	var body map[string]any
	if r.Body != nil && (r.Method == http.MethodPost || r.Method == http.MethodPatch) {
		_ = json.NewDecoder(r.Body).Decode(&body)
	}
	q := r.URL.Query()
	path := strings.TrimSuffix(r.URL.Path, "/")
	id := func() int {
		n, _ := strconv.Atoi(path[strings.LastIndex(path, "/")+1:])
		return n
	}
	num := func(v any) int {
		n, _ := v.(float64)
		return int(n)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case f.failDevices && path == "/api/dcim/devices":
		http.Error(w, "database is unavailable", http.StatusInternalServerError)
	case f.failPatch && r.Method == http.MethodPatch:
		http.Error(w, "database is unavailable", http.StatusInternalServerError)
	case r.Method == http.MethodGet && path == "/api/dcim/devices":
		var out []any
		for _, d := range f.devices {
			if strings.EqualFold(d.Serial, q.Get("serial")) {
				out = append(out, f.deviceJSON(d))
			}
		}
		page(w, out)
	case r.Method == http.MethodPost && path == "/api/dcim/devices":
		name, _ := body["name"].(string)
		for _, d := range f.devices {
			if d.Name == name {
				http.Error(w, `{"name":["Device name must be unique per site."]}`, http.StatusBadRequest)
				return
			}
		}
		f.next++
		d := &fakeDevice{ID: f.next, Name: name, Serial: body["serial"].(string), Status: body["status"].(string), TypeID: num(body["device_type"]), CustomFields: map[string]any{}, Updated: time.Now()}
		if cf, ok := body["custom_fields"].(map[string]any); ok {
			for k, v := range cf {
				d.CustomFields[k] = v
			}
		}
		f.devices[d.ID] = d
		// The device type's interface template makes eno1.
		f.next++
		f.interfaces[f.next] = &fakeInterface{ID: f.next, DeviceID: d.ID, Name: "eno1"}
		writeJSON(w, http.StatusCreated, f.deviceJSON(d))
	case r.Method == http.MethodPatch && strings.HasPrefix(path, "/api/dcim/devices/"):
		d := f.devices[id()]
		if d == nil {
			http.NotFound(w, r)
			return
		}
		if s, ok := body["status"].(string); ok {
			d.Status = s
		}
		pre := maps.Clone(d.CustomFields)
		// Only Terraform writes the approved binding: the service never does.
		if cf, ok := body["custom_fields"].(map[string]any); ok {
			for _, k := range []string{"approved_ek_hash", "approved_ek_hash_ecc"} {
				if _, wrote := cf[k]; wrote {
					f.t.Errorf("fake NetBox: the service wrote %s on device %d", k, d.ID)
				}
			}
		}
		if cf, ok := body["custom_fields"].(map[string]any); ok {
			for k, v := range cf {
				d.CustomFields[k] = v
			}
		}
		d.Updated = time.Now()
		d.Patches++
		f.logChange(d, pre, "fleetd")
		writeJSON(w, http.StatusOK, f.deviceJSON(d))
	case r.Method == http.MethodGet && path == "/api/dcim/interfaces":
		var out []any
		for _, i := range f.interfaces {
			if strconv.Itoa(i.DeviceID) == q.Get("device_id") {
				out = append(out, f.interfaceJSON(i))
			}
		}
		page(w, out)
	case r.Method == http.MethodPost && path == "/api/dcim/interfaces":
		f.next++
		i := &fakeInterface{ID: f.next, DeviceID: num(body["device"]), Name: body["name"].(string)}
		f.interfaces[i.ID] = i
		writeJSON(w, http.StatusCreated, f.interfaceJSON(i))
	case r.Method == http.MethodPatch && strings.HasPrefix(path, "/api/dcim/interfaces/"):
		i := f.interfaces[id()]
		if i == nil || num(body["primary_mac_address"]) != i.MACID {
			http.Error(w, "no such interface or MAC", http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusOK, f.interfaceJSON(i))
	case r.Method == http.MethodPost && path == "/api/dcim/mac-addresses":
		i := f.interfaces[num(body["assigned_object_id"])]
		if i == nil || body["assigned_object_type"] != "dcim.interface" {
			http.Error(w, "no such interface", http.StatusBadRequest)
			return
		}
		f.next++
		i.MACID = f.next
		i.MAC = strings.ToLower(body["mac_address"].(string))
		writeJSON(w, http.StatusCreated, map[string]any{"id": i.MACID})
	case r.Method == http.MethodGet && path == "/api/dcim/mac-addresses":
		var out []any
		if i := f.interfaces[func() int { n, _ := strconv.Atoi(q.Get("assigned_object_id")); return n }()]; i != nil {
			for _, mac := range append([]string{i.MAC}, i.Extra...) {
				if mac != "" {
					out = append(out, map[string]any{"mac_address": strings.ToUpper(mac)})
				}
			}
		}
		page(w, out)
	case r.Method == http.MethodGet && path == "/api/dcim/device-types":
		var out []any
		for id, model := range f.types {
			if model == q.Get("model") {
				out = append(out, map[string]any{"id": id})
			}
		}
		page(w, out)
	case r.Method == http.MethodPost && path == "/api/dcim/device-types":
		if f.mfrs[num(body["manufacturer"])] == "" {
			http.Error(w, "no such manufacturer", http.StatusBadRequest)
			return
		}
		f.next++
		f.types[f.next] = body["model"].(string)
		writeJSON(w, http.StatusCreated, map[string]any{"id": f.next})
	case r.Method == http.MethodGet && path == "/api/dcim/manufacturers":
		var out []any
		for id, name := range f.mfrs {
			if name == q.Get("name") {
				out = append(out, map[string]any{"id": id})
			}
		}
		page(w, out)
	case r.Method == http.MethodPost && path == "/api/dcim/manufacturers":
		f.next++
		f.mfrs[f.next] = body["name"].(string)
		writeJSON(w, http.StatusCreated, map[string]any{"id": f.next})
	case r.Method == http.MethodGet && path == "/api/dcim/sites":
		if q.Get("slug") == "folly" {
			page(w, []any{map[string]any{"id": 1}})
			return
		}
		page(w, nil)
	case r.Method == http.MethodGet && path == "/api/dcim/device-roles":
		if q.Get("slug") == "kubernetes-node" {
			page(w, []any{map[string]any{"id": 7}})
			return
		}
		page(w, nil)
	case r.Method == http.MethodGet && path == "/api/core/object-changes":
		if f.failChanges {
			http.Error(w, `{"detail":"You do not have permission to perform this action."}`, http.StatusForbidden)
			return
		}
		if q.Get("changed_object_type") != "dcim.device" {
			http.Error(w, "unfiltered changelog read", http.StatusBadRequest)
			return
		}
		out := []any{}
		for i := len(f.changes) - 1; i >= 0; i-- {
			if c := f.changes[i]; strconv.Itoa(c.DeviceID) == q.Get("changed_object_id") {
				rec := map[string]any{"id": c.ID, "time": c.Time.UTC().Format(time.RFC3339Nano), "user_name": c.User, "prechange_data": nil, "postchange_data": map[string]any{"custom_fields": c.Post}}
				if c.Pre != nil {
					rec["prechange_data"] = map[string]any{"custom_fields": c.Pre}
				}
				out = append(out, rec)
			}
		}
		total := len(out)
		offset, _ := strconv.Atoi(q.Get("offset"))
		limit, _ := strconv.Atoi(q.Get("limit"))
		out = out[min(offset, total):min(offset+limit, total)]
		writeJSON(w, http.StatusOK, map[string]any{"count": total, "results": out})
	case r.Method == http.MethodPost && path == "/api/extras/journal-entries":
		f.journal = append(f.journal, fmt.Sprintf("%v %v: %v", body["assigned_object_id"], body["kind"], body["comments"]))
		writeJSON(w, http.StatusCreated, map[string]any{"id": 1})
	default:
		f.t.Errorf("fake NetBox: unexpected %s %s", r.Method, r.URL)
		http.NotFound(w, r)
	}
}

func TestNetBoxLookupReadsTheDevice(t *testing.T) {
	f := newFakeNetBox(t)
	f.add("riptide", "MXL0172Q6L", "active", "38:22:E2:2D:96:44", map[string]any{
		"talos_class": "worker-g5", "ek_hash": strings.Repeat("A", 64), "ek_hash_ecc": strings.Repeat("b", 64),
		"approved_ek_hash": strings.Repeat("c", 64), "approved_ek_hash_ecc": nil, "attest_verdict": "attested", "last_attested": "2026-10-29T01:02:03Z", "attest_consumed_at": "2026-10-29T01:10:00Z",
	})
	nb := f.client()
	m, ok, err := nb.Lookup(context.Background(), "mxl0172q6l")
	if err != nil || !ok {
		t.Fatalf("lookup: %v %v", ok, err)
	}
	if m.Name != "riptide" || m.Class != "worker-g5" || m.Status != "active" || m.MAC != "38:22:e2:2d:96:44" || m.Pins["rsa"] != strings.Repeat("a", 64) || m.Pins["ecc"] != strings.Repeat("b", 64) || m.NetBoxID == 0 ||
		len(m.Approved) != 1 || m.Approved["rsa"] != strings.Repeat("c", 64) {
		t.Fatalf("machine %+v", m)
	}
	if _, ok, err := nb.Lookup(context.Background(), "NOPE"); ok || err != nil {
		t.Fatalf("unknown serial: %v %v", ok, err)
	}
	st, ok, err := nb.Verdict(context.Background(), "MXL0172Q6L")
	if err != nil || !ok || st.Status != protocol.StatusAttested || st.Node != "riptide" || st.Class != "worker-g5" || st.Site != "folly" ||
		!st.AttestedAt.Equal(time.Date(2026, 10, 29, 1, 2, 3, 0, time.UTC)) || !st.ConsumedAt.Equal(time.Date(2026, 10, 29, 1, 10, 0, 0, time.UTC)) {
		t.Fatalf("verdict %+v %v %v", st, ok, err)
	}
	f.add("swell", "SW-1", "planned", "", map[string]any{"attest_verdict": "pending-approval"})
	if _, ok, _ := nb.Verdict(context.Background(), "SW-1"); ok {
		t.Fatal("a pending device has a verdict")
	}
	f.add("surge", "SU-1", "failed", "", map[string]any{"attest_verdict": "quarantined: policy"})
	if st, ok, _ := nb.Verdict(context.Background(), "SU-1"); !ok || st.Status != protocol.StatusQuarantined {
		t.Fatalf("quarantined verdict %+v %v", st, ok)
	}
	// A retired device has no verdict to serve, whatever its fields say.
	f.add("retired", "RT-1", "offline", "", map[string]any{"attest_verdict": StatusAttested, "last_attested": "2026-10-29T01:02:03Z"})
	if _, ok, _ := nb.Verdict(context.Background(), "RT-1"); ok {
		t.Fatal("a retired device has a verdict")
	}
	// A 200 with no page is not an answer.
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]any{}) }))
	defer empty.Close()
	hollow := &NetBox{URL: empty.URL, Token: "nbt_x", Client: empty.Client()}
	if _, ok, err := hollow.Lookup(context.Background(), "ANY"); err == nil || ok {
		t.Fatalf("an empty page read as no such device: %v %v", ok, err)
	}
}

func TestNetBoxRecordWritesTheVerdict(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	f.add("swell", "SW-1", "planned", "aa:bb:cc:dd:ee:01", nil)
	now := time.Date(2026, 10, 29, 2, 0, 0, 0, time.UTC)
	pass := Record{Machine: "swell", Serial: "SW-1", Status: StatusAttested, Class: "worker-g5", SKU: "SKU1", BIOS: "B1", EKProven: true,
		EKHashes: map[string]string{"rsa": strings.Repeat("1", 64), "ecc": strings.Repeat("2", 64)}, EKIssuers: []string{"Infineon OPTIGA(TM) TPM 2.0 RSA CA 042"},
		LDevIDSerial: "0a", LAKSerial: "0b", AttestedAt: now, LDevIDNotAfter: now.Add(90 * 24 * time.Hour)}
	if err := nb.Record(context.Background(), pass); err != nil {
		t.Fatal(err)
	}
	d := f.bySerial("SW-1")
	cf := d.CustomFields
	if d.Status != "planned" || cf["attest_verdict"] != "attested" || cf["ek_hash"] != strings.Repeat("1", 64) || cf["ek_hash_ecc"] != strings.Repeat("2", 64) ||
		cf["ldevid_serial"] != "0a" || cf["lak_serial"] != "0b" || cf["last_attested"] != "2026-10-29T02:00:00Z" || cf["ldevid_not_after"] != "2027-01-27" || cf["sku"] != "SKU1" || cf["bios_version"] != "B1" {
		t.Fatalf("after a pass: %s %+v", d.Status, cf)
	}
	// A pass whose session did not prove the EKs, a renewal or an adopted
	// record, writes no pins and no SMBIOS facts it did not see.
	renewal := pass
	renewal.EKProven, renewal.Renewed, renewal.SKU, renewal.BIOS = false, true, "", ""
	renewal.EKHashes = map[string]string{"rsa": strings.Repeat("9", 64)}
	renewal.LDevIDSerial = "0c"
	if err := nb.Record(context.Background(), renewal); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SW-1"); d.CustomFields["ek_hash"] != strings.Repeat("1", 64) || d.CustomFields["ldevid_serial"] != "0c" || d.CustomFields["sku"] != "SKU1" {
		t.Fatalf("after a renewal: %+v", d.CustomFields)
	}
	quarantine := Record{Machine: "swell", Serial: "SW-1", Status: StatusQuarantined, Reason: reasonEKHash, Detail: []string{"rsa EK x is not swell's pinned y **[bold](http://x)**"},
		EKHashes: map[string]string{"rsa": strings.Repeat("f", 64)}, EKProven: true, SKU: "SKU-CLAIMED"}
	if err := nb.Record(context.Background(), quarantine); err != nil {
		t.Fatal(err)
	}
	d = f.bySerial("SW-1")
	if d.Status != "planned" || d.CustomFields["attest_verdict"] != "quarantined: ek-hash-mismatch" {
		t.Fatalf("after a quarantine: %s %+v", d.Status, d.CustomFields)
	}
	// A refusal never rewrites the pins nor the hardware facts.
	if d.CustomFields["ek_hash"] != strings.Repeat("1", 64) || d.CustomFields["sku"] != "SKU1" {
		t.Fatalf("a quarantine rewrote ek_hash or sku: %+v", d.CustomFields)
	}
	// A first intake's wait is noted, but never over a pass or a quarantine on file.
	if err := nb.MarkPending(context.Background(), "SW-1", "no EK hash on record"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SW-1"); d.CustomFields["attest_verdict"] != "quarantined: ek-hash-mismatch" || d.Status != "planned" {
		t.Fatalf("a claim wrote over the quarantine: %s %+v", d.Status, d.CustomFields)
	}
	f.add("shale", "SL-1", "planned", "", nil)
	if err := nb.MarkPending(context.Background(), "SL-1", "no EK hash on record"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SL-1"); d.CustomFields["attest_verdict"] != StatusPending || d.Status != "planned" {
		t.Fatalf("after pending: %s %+v", d.Status, d.CustomFields)
	}
	f.add("shoal", "SH-1", "planned", "", map[string]any{"attest_verdict": StatusAttested})
	if err := nb.MarkPending(context.Background(), "SH-1", "a claim"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SH-1"); d.CustomFields["attest_verdict"] != StatusAttested || d.Patches != 0 {
		t.Fatalf("a claim wrote over a pass: %+v", d.CustomFields)
	}
	// Nor over a quarantine: that stands until the owner clears it.
	f.add("surge", "SU-9", "failed", "", map[string]any{"attest_verdict": "quarantined: policy"})
	if err := nb.MarkPending(context.Background(), "SU-9", "a claim"); err != nil {
		t.Fatal(err)
	}
	if d := f.bySerial("SU-9"); d.CustomFields["attest_verdict"] != "quarantined: policy" || d.Patches != 0 {
		t.Fatalf("a claim wrote over a quarantine: %+v", d.CustomFields)
	}
	if err := nb.Record(context.Background(), Record{Serial: "NOPE", Status: StatusAttested}); err == nil {
		t.Fatal("a record for an unknown serial was written")
	}
	if err := nb.Record(context.Background(), Record{Serial: "SW-1", Status: StatusPending}); err == nil {
		t.Fatal("a pending record was written as a verdict")
	}
	// The journal follows the write on its own, with the claimed text flattened.
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		n := len(f.journal)
		entries := append([]string(nil), f.journal...)
		f.mu.Unlock()
		if n == 6 {
			for _, e := range entries {
				if strings.Contains(e, "**") || strings.Contains(e, "[bold]") || strings.Contains(e, "(http") {
					t.Fatalf("journal entry carries Markdown: %q", e)
				}
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("journal %q", entries)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestNetBoxSelectDecodesBothShapes(t *testing.T) {
	for raw, want := range map[string]string{`"worker-g5"`: "worker-g5", `{"value":"controlplane","label":"Control plane"}`: "controlplane", `null`: "", `7`: ""} {
		var s nbSelect
		if err := json.Unmarshal([]byte(raw), &s); err != nil || string(s) != want {
			t.Errorf("nbSelect(%s) = %q %v, want %q", raw, s, err, want)
		}
	}
}

func TestAuditLines(t *testing.T) {
	var b strings.Builder
	a := &Audit{W: &b, Site: "folly", Now: func() time.Time { return time.Date(2026, 10, 29, 3, 0, 0, 0, time.UTC) }}
	a.Emit(AuditEntry{Event: auditVerdict, Node: "riptide", Serial: "MXL0172Q6L", Class: "worker-g5", Status: "pass"})
	want := `{"event":"attest.verdict","site":"folly","node":"riptide","serial":"MXL0172Q6L","class":"worker-g5","status":"pass","ts":"2026-10-29T03:00:00Z"}` + "\n"
	if b.String() != want {
		t.Fatalf("audit line %q", b.String())
	}
	var quiet *Audit
	quiet.Emit(AuditEntry{Event: auditIssue})
}

func TestIntakeName(t *testing.T) {
	for claim, want := range map[protocol.Machine]string{
		{Serial: "ABC", Hostname: "swell"}:       "swell",
		{Serial: "ABC", Hostname: "hookos"}:      "intake-abc",
		{Serial: "ABC", Hostname: "Not A Host!"}: "intake-abc",
		{Serial: "ABC"}:                          "intake-abc",
		{Serial: "ABC", Hostname: "node-01.lan"}: "intake-abc",
		{Serial: " abc ", Hostname: "localhost"}: "intake-abc",
	} {
		if got := intakeName(claim); got != want {
			t.Errorf("intakeName(%+v) = %q, want %q", claim, got, want)
		}
	}
}

// A pass replaces a pin on file only with the approved binding it matched;
// otherwise only an empty pin is written, so a second TPM claiming a stub's
// serial on another anchor cannot re-key it.
func TestNetBoxRecordKeepsAPinOnFile(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	f.add("swell", "SW-1", "planned", "", map[string]any{"ek_hash": strings.Repeat("a", 64)})
	pass := Record{Machine: "swell", Serial: "SW-1", Status: StatusAttested, EKProven: true, AttestedAt: time.Now(),
		EKHashes: map[string]string{"rsa": strings.Repeat("1", 64), "ecc": strings.Repeat("2", 64)}}
	if err := nb.Record(context.Background(), pass); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-1").CustomFields; cf["ek_hash"] != strings.Repeat("a", 64) || cf["ek_hash_ecc"] != strings.Repeat("2", 64) {
		t.Fatalf("pins after the pass: %+v", cf)
	}
	pass.approved = map[string]string{"rsa": strings.Repeat("1", 64)}
	if err := nb.Record(context.Background(), pass); err != nil {
		t.Fatal(err)
	}
	if cf := f.bySerial("SW-1").CustomFields; cf["ek_hash"] != strings.Repeat("1", 64) || cf["approved_ek_hash"] != nil {
		t.Fatalf("pins after a pass that matched its approved binding: %+v", cf)
	}
}

func TestValidMAC(t *testing.T) {
	for mac, want := range map[string]bool{"38:22:E2:2D:96:44": true, "38-22-e2-2d-96-44": true, "": false, "not-a-mac": false, "38:22:e2:2d:96": false, "3822.e22d.9644": false, "38:22:e2:2d:96:44\n": true} {
		if got := validMAC(mac); got != want {
			t.Errorf("validMAC(%q) = %v, want %v", mac, got, want)
		}
	}
}

// A MAC write stands only when the interface ends up holding that one MAC
// as its primary: two anchors binding one stub cannot both win.
func TestSetMACRefusesASharedInterface(t *testing.T) {
	f := newFakeNetBox(t)
	nb := f.client()
	d := f.add("swell", "SW-1", "planned", "", nil)
	if wrote, err := nb.setMAC(context.Background(), d.ID, "02:00:00:00:00:01"); err != nil || !wrote {
		t.Fatalf("a sole MAC: %v %v", wrote, err)
	}
	if wrote, err := nb.setMAC(context.Background(), d.ID, "02:00:00:00:00:01"); err != nil || wrote {
		t.Fatalf("the same MAC again: %v %v", wrote, err)
	}
	other := f.add("drift", "SW-2", "planned", "", nil)
	f.mu.Lock()
	for _, i := range f.interfaces {
		if i.DeviceID == other.ID {
			i.Extra = []string{"02:00:00:00:00:99"}
		}
	}
	f.mu.Unlock()
	if _, err := nb.setMAC(context.Background(), other.ID, "02:00:00:00:00:02"); !errors.Is(err, errMACTaken) {
		t.Fatalf("an interface another anchor wrote: %v", err)
	}
}
