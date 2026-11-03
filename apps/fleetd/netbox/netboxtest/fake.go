// Package netboxtest is the one in-memory NetBox the fleet and attest tests
// share: the part of NetBox's REST API fleetd uses, over device, interface,
// MAC, switch and changelog records that are plain JSON objects.
package netboxtest

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Change is one record of the fake's changelog.
type Change struct {
	ID       int
	DeviceID int
	User     string
	Time     time.Time
	Pre      map[string]any
	Post     map[string]any
}

// Fake serves a device list and records the patches and journal entries it
// receives. Its fields are the store: a test seeds and reads them under Mu.
type Fake struct {
	Mu sync.Mutex
	// T, when set, fails the test on a request the fake does not serve.
	T testing.TB

	Devices  []map[string]any
	Ifaces   []map[string]any
	MACs     []map[string]any
	Switches []map[string]any
	Patches  []map[string]any
	Journals []map[string]any
	Deleted  []string

	// Changes is the changelog, oldest first.
	Changes []Change

	// Apply makes a device PATCH change the stored device, as NetBox does,
	// and log the change as User.
	Apply bool
	User  string
	// OnPatch sees each device PATCH body before it is applied.
	OnPatch func(id string, patch map[string]any)

	// FailPatch answers every device write 502, FailDevices every device
	// read, FailMACs every MAC read and FailChanges every changelog read.
	FailPatch, FailDevices, FailMACs, FailChanges bool

	// PageSize > 0 pages the device list with next links that name a foreign
	// host, as NetBox's do. Pages counts device list requests.
	PageSize int
	Pages    int

	NextID int
}

// ID is a fresh record ID.
func (f *Fake) ID() int {
	if f.NextID == 0 {
		f.NextID = 1000
	}
	f.NextID++
	return f.NextID
}

// Iface is the interface with this ID, nil when there is none.
func (f *Fake) Iface(id int) map[string]any {
	for _, i := range f.Ifaces {
		if fmt.Sprint(i["id"]) == fmt.Sprint(id) {
			return i
		}
	}
	return nil
}

// LogChange appends a change of a device's custom fields by user.
func (f *Fake) LogChange(deviceID int, pre, post map[string]any, user string) {
	f.NextID++
	f.Changes = append(f.Changes, Change{ID: f.NextID, DeviceID: deviceID, User: user, Time: time.Now(), Pre: pre, Post: maps.Clone(post)})
}

// Set changes a field of the first device, or its status, under the lock.
func (f *Fake) Set(field string, value any) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if field == "status" {
		f.Devices[0]["status"] = value
		return
	}
	f.Devices[0]["custom_fields"].(map[string]any)[field] = value
}

// FailPatches turns the device write failure on or off.
func (f *Fake) FailPatches(fail bool) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	f.FailPatch = fail
}

// JournalWith is the journal comments that contain substr.
func (f *Fake) JournalWith(substr string) []string {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	var out []string
	for _, j := range f.Journals {
		if c, _ := j["comments"].(string); strings.Contains(c, substr) {
			out = append(out, c)
		}
	}
	return out
}

func customFields(d map[string]any) map[string]any {
	cf, _ := d["custom_fields"].(map[string]any)
	return cf
}

// applyPatch merges a device PATCH into the stored device.
func (f *Fake) applyPatch(id string, p map[string]any) {
	for _, d := range f.Devices {
		if fmt.Sprint(d["id"]) != id {
			continue
		}
		pre := maps.Clone(customFields(d))
		for k, v := range p {
			switch k {
			case "id":
			case "custom_fields":
				for ck, cv := range v.(map[string]any) {
					d["custom_fields"].(map[string]any)[ck] = cv
				}
			case "status":
				d["status"] = map[string]any{"value": v, "label": v}
			default:
				d[k] = v
			}
		}
		d["last_updated"] = time.Now().UTC().Format(time.RFC3339Nano)
		n, _ := strconv.Atoi(id)
		f.LogChange(n, pre, customFields(d), f.User)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func listed(w http.ResponseWriter, results []map[string]any) {
	if results == nil {
		results = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": len(results), "next": nil, "results": results})
}

// Handler is the fake as an http.Handler.
func (f *Fake) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if f.T != nil {
			f.T.Errorf("fake NetBox: unexpected %s %s", r.Method, r.URL)
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("GET /api/dcim/devices/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		f.Pages++
		if f.FailDevices {
			http.Error(w, "database is unavailable", http.StatusInternalServerError)
			return
		}
		q := r.URL.Query()
		if q.Get("role") == "switch" {
			listed(w, f.Switches)
			return
		}
		all := f.Devices
		if all == nil {
			all = []map[string]any{}
		}
		if serial, ok := q["serial"]; ok {
			all = []map[string]any{}
			for _, d := range f.Devices {
				if s, _ := d["serial"].(string); strings.EqualFold(s, serial[0]) {
					all = append(all, d)
				}
			}
		}
		results := all
		var next any
		if f.PageSize > 0 {
			offset, _ := strconv.Atoi(q.Get("offset"))
			end := min(offset+f.PageSize, len(all))
			results = all[offset:end]
			if end < len(all) {
				nq := r.URL.Query()
				nq.Set("offset", strconv.Itoa(end))
				next = "https://netbox.example/api/dcim/devices/?" + nq.Encode()
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": len(all), "next": next, "results": results})
	})
	mux.HandleFunc("PATCH /api/dcim/devices/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		if f.FailPatch {
			http.Error(w, `{"detail":"down"}`, http.StatusBadGateway)
			return
		}
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		if f.OnPatch != nil {
			f.OnPatch(r.PathValue("id"), p)
		}
		if f.Apply {
			f.applyPatch(r.PathValue("id"), p)
		}
		p["id"] = r.PathValue("id")
		f.Patches = append(f.Patches, p)
		w.Write([]byte("{}"))
	})
	mux.HandleFunc("DELETE /api/dcim/devices/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		for i, d := range f.Devices {
			if fmt.Sprint(d["id"]) == r.PathValue("id") {
				f.Deleted = append(f.Deleted, d["name"].(string))
				f.Devices = slices.Delete(f.Devices, i, i+1)
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("GET /api/dcim/interfaces/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		q := r.URL.Query()
		var results []map[string]any
		for _, i := range f.Ifaces {
			if ids := q["device_id"]; len(ids) > 0 {
				dev := fmt.Sprint(i["device"].(map[string]any)["id"])
				if !slices.Contains(ids, dev) {
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
		listed(w, results)
	})
	mux.HandleFunc("GET /api/dcim/interfaces/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		id, _ := strconv.Atoi(r.PathValue("id"))
		i := f.Iface(id)
		if i == nil {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, http.StatusOK, i)
	})
	mux.HandleFunc("POST /api/dcim/interfaces/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		var i map[string]any
		json.NewDecoder(r.Body).Decode(&i)
		i["id"] = f.ID()
		i["device"] = map[string]any{"id": i["device"]}
		f.Ifaces = append(f.Ifaces, i)
		writeJSON(w, http.StatusCreated, i)
	})
	mux.HandleFunc("PATCH /api/dcim/interfaces/{id}/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		id, _ := strconv.Atoi(r.PathValue("id"))
		i := f.Iface(id)
		if i == nil {
			http.Error(w, "no such interface", http.StatusBadRequest)
			return
		}
		for _, m := range f.MACs {
			if fmt.Sprint(m["id"]) == fmt.Sprint(p["primary_mac_address"]) {
				i["primary_mac_address"] = map[string]any{"id": m["id"], "mac_address": m["mac_address"]}
				writeJSON(w, http.StatusOK, i)
				return
			}
		}
		http.Error(w, "no such MAC", http.StatusBadRequest)
	})
	mux.HandleFunc("GET /api/dcim/mac-addresses/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		if f.FailMACs {
			http.Error(w, `{"detail":"down"}`, http.StatusBadGateway)
			return
		}
		q := r.URL.Query()
		var results []map[string]any
		for _, m := range f.MACs {
			if id := q.Get("assigned_object_id"); id != "" {
				if fmt.Sprint(m["assigned_object_id"]) == id {
					results = append(results, m)
				}
				continue
			}
			if strings.EqualFold(m["mac_address"].(string), q.Get("mac_address")) {
				results = append(results, m)
			}
		}
		listed(w, results)
	})
	mux.HandleFunc("POST /api/dcim/mac-addresses/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		var m map[string]any
		json.NewDecoder(r.Body).Decode(&m)
		if to, ok := m["assigned_object_id"]; ok {
			n, _ := to.(float64)
			if f.Iface(int(n)) == nil || m["assigned_object_type"] != "dcim.interface" {
				http.Error(w, "no such interface", http.StatusBadRequest)
				return
			}
		}
		m["id"] = f.ID()
		f.MACs = append(f.MACs, m)
		writeJSON(w, http.StatusCreated, m)
	})
	mux.HandleFunc("GET /api/core/object-changes/", func(w http.ResponseWriter, r *http.Request) {
		f.Mu.Lock()
		defer f.Mu.Unlock()
		q := r.URL.Query()
		if f.FailChanges {
			http.Error(w, `{"detail":"You do not have permission to perform this action."}`, http.StatusForbidden)
			return
		}
		if q.Get("changed_object_type") != "dcim.device" {
			http.Error(w, "unfiltered changelog read", http.StatusBadRequest)
			return
		}
		out := []any{}
		for i := len(f.Changes) - 1; i >= 0; i-- {
			if c := f.Changes[i]; strconv.Itoa(c.DeviceID) == q.Get("changed_object_id") {
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
	})
	mux.HandleFunc("POST /api/extras/journal-entries/", func(w http.ResponseWriter, r *http.Request) {
		var p map[string]any
		json.NewDecoder(r.Body).Decode(&p)
		f.Mu.Lock()
		f.Journals = append(f.Journals, p)
		f.Mu.Unlock()
		writeJSON(w, http.StatusCreated, map[string]any{"id": 1})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer nbt_") {
			http.Error(w, "no token", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
