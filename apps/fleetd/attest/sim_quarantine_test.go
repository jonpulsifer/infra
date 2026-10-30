//go:build cgo

// A quarantine whose NetBox write failed still withdraws the identity.
package attest

import (
	"net/http"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// NetBox mode with the quarantine's write failed: the service's own
// quarantine beats NetBox's stale pass.
func TestQuarantineStandsWhenItsNetBoxWriteFailed(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"talos_class": "worker-g5"})
	f.set(simSerial, func(d *fakeDevice) {
		d.CustomFields["ek_hash"], d.CustomFields["ek_hash_ecc"] = h.hashes["rsa"], h.hashes["ecc"]
	})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	f.settled(t, simSerial, 2)
	f.setFailing(false, true)
	h.tamper = func(r *protocol.EvidenceRequest) { r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("tampered boot: %+v", r.Verdict)
	}
	h.tamper = nil
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusForbidden {
		t.Fatalf("DevID after the quarantine with NetBox stale: %d", code)
	}
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusQuarantined {
		t.Fatalf("the quarantine did not stand: %+v", rec)
	}
}
