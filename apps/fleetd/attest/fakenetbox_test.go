package attest

import (
	"fmt"
	"maps"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/netbox/netboxtest"
)

// fakeNetBox is the shared in-memory NetBox seen through the typed helpers
// the attestation tests use: devices with custom fields, their interfaces
// and MACs, and a journal.
type fakeNetBox struct {
	*netboxtest.Fake
	mu  *sync.Mutex
	t   *testing.T
	srv *httptest.Server
	// author is the user an edit through add or set is logged as; the
	// service's own writes are fleetd's.
	author string
}

type fakeDevice struct {
	ID           int
	Name         string
	Serial       string
	Status       string
	CustomFields map[string]any
	Updated      time.Time
	// Patches counts the service's writes: a pass makes two, at evidence
	// and at confirm, and a test waits for both before it edits the device.
	Patches int
}

// fakeTerraform is the user the fake logs Terraform's edits as.
const fakeTerraform = "terraform"

const fakeDeviceModel = "HP EliteDesk 800 G5 Desktop Mini"

func newFakeNetBox(t *testing.T) *fakeNetBox {
	nb := &netboxtest.Fake{T: t, Apply: true, User: "fleetd", NextID: 100}
	f := &fakeNetBox{Fake: nb, mu: &nb.Mu, t: t, author: fakeTerraform}
	nb.OnPatch = func(id string, p map[string]any) {
		if cf, ok := p["custom_fields"].(map[string]any); ok {
			for _, k := range []string{"approved_ek_hash", "approved_ek_hash_ecc"} {
				if _, wrote := cf[k]; wrote {
					t.Errorf("fake NetBox: the service wrote %s on device %s", k, id)
				}
			}
		}
	}
	f.srv = httptest.NewServer(nb.Handler())
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeNetBox) client() *NetBox {
	return NewNetBox(f.srv.URL, "nbt_test", f.srv.Client(), nil)
}

func deviceMap(d *fakeDevice) map[string]any {
	return map[string]any{
		"id": d.ID, "name": d.Name, "serial": d.Serial,
		"status":        map[string]any{"value": d.Status, "label": d.Status},
		"site":          map[string]any{"id": 1, "slug": "folly"},
		"device_type":   map[string]any{"id": 1, "model": fakeDeviceModel},
		"last_updated":  d.Updated.UTC().Format(time.RFC3339Nano),
		"custom_fields": d.CustomFields,
	}
}

func fakeDeviceOf(m map[string]any) *fakeDevice {
	d := &fakeDevice{Name: m["name"].(string), Serial: m["serial"].(string), CustomFields: m["custom_fields"].(map[string]any)}
	d.ID, _ = m["id"].(int)
	d.Status = m["status"].(map[string]any)["value"].(string)
	d.Updated, _ = time.Parse(time.RFC3339Nano, m["last_updated"].(string))
	return d
}

// add seeds a device with a MAC on eno1.
func (f *fakeNetBox) add(name, serial, status, mac string, fields map[string]any) *fakeDevice {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	d := &fakeDevice{ID: f.ID(), Name: name, Serial: serial, Status: status, CustomFields: map[string]any{}, Updated: time.Now()}
	for k, v := range fields {
		d.CustomFields[k] = v
	}
	f.Devices = append(f.Devices, deviceMap(d))
	f.LogChange(d.ID, nil, d.CustomFields, f.author)
	i := map[string]any{"id": f.ID(), "name": "eno1", "device": map[string]any{"id": d.ID}, "primary_mac_address": nil}
	f.Ifaces = append(f.Ifaces, i)
	if mac != "" {
		f.assignMAC(i, mac)
	}
	return d
}

// assignMAC makes mac the primary MAC of interface i, as the owner entering
// it in NetBox would.
func (f *fakeNetBox) assignMAC(i map[string]any, mac string) {
	m := map[string]any{"id": f.ID(), "mac_address": strings.ToUpper(mac), "assigned_object_type": "dcim.interface", "assigned_object_id": i["id"]}
	f.MACs = append(f.MACs, m)
	i["primary_mac_address"] = map[string]any{"id": m["id"], "mac_address": m["mac_address"]}
}

// addExtraMAC assigns mac to the device's interfaces besides their primary,
// as another anchor's write that has not set its primary yet leaves.
func (f *fakeNetBox) addExtraMAC(deviceID int, mac string) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	for _, i := range f.Ifaces {
		if fmt.Sprint(i["device"].(map[string]any)["id"]) == fmt.Sprint(deviceID) {
			f.MACs = append(f.MACs, map[string]any{"id": f.ID(), "mac_address": strings.ToUpper(mac), "assigned_object_type": "dcim.interface", "assigned_object_id": i["id"]})
		}
	}
}

// bindMAC makes mac the primary MAC of the device's interfaces, as another
// anchor's bind would. The caller holds the lock.
func (f *fakeNetBox) bindMAC(deviceID int, mac string) {
	for _, i := range f.Ifaces {
		if fmt.Sprint(i["device"].(map[string]any)["id"]) == fmt.Sprint(deviceID) {
			f.assignMAC(i, mac)
		}
	}
}

// writeBack stores the scalar fields of a device a test edited in place
// while it held the lock.
func (f *fakeNetBox) writeBack(d *fakeDevice) {
	for _, m := range f.Devices {
		if fmt.Sprint(m["id"]) == fmt.Sprint(d.ID) {
			m["name"], m["serial"], m["status"] = d.Name, d.Serial, map[string]any{"value": d.Status, "label": d.Status}
			m["custom_fields"] = d.CustomFields
		}
	}
}

// setFailing switches the fake's failure modes under the lock.
func (f *fakeNetBox) setFailing(devices, patch bool) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	f.FailDevices, f.FailPatch = devices, patch
}

// count is how many devices the fake holds.
func (f *fakeNetBox) count() int {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	return len(f.Devices)
}

func (f *fakeNetBox) find(serial string) map[string]any {
	for _, m := range f.Devices {
		if strings.EqualFold(m["serial"].(string), serial) {
			return m
		}
	}
	return nil
}

// bySerial is a snapshot of the device with serial, since the service's
// recorders write the store from their own goroutines.
func (f *fakeNetBox) bySerial(serial string) *fakeDevice {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	m := f.find(serial)
	if m == nil {
		return nil
	}
	d := fakeDeviceOf(m)
	d.CustomFields = maps.Clone(d.CustomFields)
	for _, p := range f.Patches {
		if p["id"] == fmt.Sprint(d.ID) {
			d.Patches++
		}
	}
	return d
}

// set changes the device with serial under the lock, as the owner editing
// it in NetBox would.
func (f *fakeNetBox) set(serial string, change func(*fakeDevice)) {
	f.Mu.Lock()
	defer f.Mu.Unlock()
	m := f.find(serial)
	if m == nil {
		f.t.Fatalf("fake NetBox: no device with serial %s", serial)
	}
	d := fakeDeviceOf(m)
	pre := maps.Clone(d.CustomFields)
	change(d)
	d.Updated = time.Now()
	m["name"], m["serial"], m["status"] = d.Name, d.Serial, map[string]any{"value": d.Status, "label": d.Status}
	m["custom_fields"], m["last_updated"] = d.CustomFields, d.Updated.UTC().Format(time.RFC3339Nano)
	f.LogChange(d.ID, pre, d.CustomFields, f.author)
}

// macOf is the primary MAC on the device's interfaces.
func (f *fakeNetBox) macOf(serial string) string {
	id := f.bySerial(serial).ID
	f.Mu.Lock()
	defer f.Mu.Unlock()
	for _, i := range f.Ifaces {
		if fmt.Sprint(i["device"].(map[string]any)["id"]) != fmt.Sprint(id) {
			continue
		}
		if p, _ := i["primary_mac_address"].(map[string]any); p != nil {
			return strings.ToLower(p["mac_address"].(string))
		}
	}
	return ""
}

// journalLines is the journal as "<device> <kind>: <comment>", for a caller
// that holds the lock.
func (f *fakeNetBox) journalLines() []string {
	var out []string
	for _, j := range f.Journals {
		out = append(out, fmt.Sprintf("%v %v: %v", j["assigned_object_id"], j["kind"], j["comments"]))
	}
	return out
}
