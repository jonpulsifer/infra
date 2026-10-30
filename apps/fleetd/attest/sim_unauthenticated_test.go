//go:build cgo

// What a request that proves nothing may do: nothing.
package attest

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// Serials are public: a request that proves nothing withdraws nothing. A
// wrong MAC at intake and junk renewal evidence leave the record, the DevID
// and NetBox as they were.
func TestUnauthenticatedRequestsWithdrawNothing(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, h.bound(map[string]any{"talos_class": "worker-g5"}))
	f.set(simSerial, func(d *fakeDevice) {
		d.CustomFields["ek_hash"], d.CustomFields["ek_hash_ecc"] = h.hashes["rsa"], h.hashes["ecc"]
	})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	before := f.settled(t, simSerial, 2)
	rec, _, _ := h.v.Store.Record("testbox")
	unchanged := func(what string) {
		t.Helper()
		after := f.bySerial(simSerial)
		now, _, _ := h.v.Store.Record("testbox")
		if after.Patches != before.Patches || after.Status != before.Status || after.CustomFields["attest_verdict"] != StatusAttested ||
			now.Status != StatusAttested || now.LDevIDSerial != rec.LDevIDSerial || !now.UpdatedAt.Equal(rec.UpdatedAt) {
			t.Fatalf("%s changed the record: NetBox %d writes %s %+v; record %+v", what, after.Patches, after.Status, after.CustomFields, now)
		}
		if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
			t.Fatalf("%s withdrew the DevID: %d", what, code)
		}
	}

	if r := refusal(t, func() error { _, err := h.run(simSerial, "02:00:00:00:00:99"); return err }()); r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != reasonMACMismatch {
		t.Fatalf("wrong MAC: %+v", r.Verdict)
	}
	unchanged("a wrong MAC")

	// Junk renewal evidence: a session anyone can open, then a quote the LAK did not sign.
	rr := httptest.NewRecorder()
	h.srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathRenew, strings.NewReader(`{"serial":"`+simSerial+`"}`)))
	if rr.Code != http.StatusOK {
		t.Fatalf("renew start: %d %s", rr.Code, rr.Body.String())
	}
	var started protocol.RenewStart
	if err := json.Unmarshal(rr.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	junk, _ := json.Marshal(protocol.RenewEvidence{
		Quote:    protocol.Quote{Quote: bytes.Repeat([]byte{1}, 64), Signature: bytes.Repeat([]byte{2}, 64)},
		PCRs:     []protocol.PCR{{Index: 0, Digest: make([]byte, 32)}},
		EventLog: h.eventLog,
	})
	rr = httptest.NewRecorder()
	h.srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, strings.Replace(protocol.PathRenewEvidence, "{session}", started.Session, 1), bytes.NewReader(junk)))
	if rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), `"verdict":"refused"`) || !strings.Contains(rr.Body.String(), reasonQuote) {
		t.Fatalf("junk evidence: %d %s", rr.Code, rr.Body.String())
	}
	unchanged("junk renewal evidence")
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"attested"`) {
		t.Fatalf("verdict after junk evidence: %d %s", code, body)
	}
	if !strings.Contains(h.audit.String(), `"status":"refused"`) {
		t.Fatalf("no audit line for the refusals:\n%s", h.audit.String())
	}
}
