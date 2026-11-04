//go:build cgo

package attest

import (
	"maps"
	"net/http"
	"strings"
	"testing"
)

// A retired node's record is kept and served by nothing: not by /devid, its
// files or /verdict, with NetBox up or down, and not in the expiry metric.
// A device planned again with a binding attests into a fresh record.
func TestRetiredRecordIsNeverServed(t *testing.T) {
	h, f := activeNode(t)
	before, _, _ := h.v.Store.Record("testbox")
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("GET /devid before the retirement: %d", code)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_ldevid_expiry_timestamp_seconds{machine="testbox"}`) {
		t.Fatal("no expiry metric for an attested node")
	}

	f.set(simSerial, func(d *fakeDevice) { d.Status = "offline" })
	if err := h.v.Retire(simSerial); err != nil {
		t.Fatal(err)
	}
	f.setFailing(true, false)

	refused := func(when string, paths ...string) {
		t.Helper()
		for _, path := range append([]string{"/devid/" + simSerial, "/devid/" + simSerial + "/ldevid.crt", "/devid/" + simSerial + "/ldevid.priv"}, paths...) {
			if code, body := h.get(path); code != http.StatusNotFound {
				t.Fatalf("GET %s %s: %d %s", path, when, code, body)
			}
		}
	}
	refused("with NetBox down", "/verdict/"+simSerial)

	rec, ok, _ := h.v.Store.Record("testbox")
	if !ok || rec.Status != StatusRetired || rec.RetiredAt.IsZero() || rec.LDevIDSerial != before.LDevIDSerial {
		t.Fatalf("the retired record: %+v", rec)
	}
	if !h.v.Store.HasFiles("testbox") {
		t.Fatal("the retirement removed the record's files")
	}
	m, _ := h.v.Metrics()
	for _, name := range []string{`talos_attest_ldevid_expiry_timestamp_seconds{machine="testbox"`, `talos_attest_last_checked_timestamp_seconds{machine="testbox"`} {
		if strings.Contains(m, name) {
			t.Fatalf("a retired node still has %s:\n%s", name, m)
		}
	}
	if !strings.Contains(m, `talos_attest_machine_status{machine="testbox",status="retired"} 1`) {
		t.Fatalf("no retired status:\n%s", m)
	}

	// Whatever NetBox says later, the retired record serves no LDevID.
	f.setFailing(false, false)
	f.set(simSerial, func(d *fakeDevice) { d.Status = "active" })
	refused("when NetBox says active")

	// Planned again with a binding, the node attests into a fresh record.
	f.set(simSerial, func(d *fakeDevice) {
		d.Status = "planned"
		maps.Copy(d.CustomFields, h.bound(nil))
	})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatalf("the re-provisioned node: %v", err)
	}
	rec, _, _ = h.v.Store.Record("testbox")
	if rec.Status != StatusAttested || !rec.RetiredAt.IsZero() {
		t.Fatalf("the fresh record: %+v", rec)
	}
	f.set(simSerial, func(d *fakeDevice) { d.Status = "active" })
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("GET /devid after the new intake: %d", code)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_ldevid_expiry_timestamp_seconds{machine="testbox"}`) {
		t.Fatal("no expiry metric for the re-provisioned node")
	}
}
