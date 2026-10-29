//go:build cgo

// What a request that proves nothing may do (nothing), and how the anchors
// follow one another's newest verdict.
package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// Serials are public: a request that proves nothing withdraws nothing. A
// wrong MAC at intake and junk renewal evidence leave the record, the DevID
// and NetBox as they were.
func TestUnauthenticatedRequestsWithdrawNothing(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "staged", simMAC, map[string]any{"talos_class": "worker-g5"})
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

func mustDER(t *testing.T, pemChain string) []byte {
	t.Helper()
	blk, _ := pem.Decode([]byte(pemChain))
	if blk == nil {
		t.Fatal("no PEM certificate")
	}
	return blk.Bytes
}

// An anchor that did not run the intake serves the newest attestation from
// its peers, keeps a copy, and follows a renewal or a quarantine served
// elsewhere, so its metrics are the fleet's.
func TestPeersAdoptTheNewestVerdict(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	res, err := h.run(simSerial, simMAC)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := x509.ParseCertificate(res.Verdict.LDevIDCert)
	peer := httptest.NewServer(h.srv.DevIDHandler())
	defer peer.Close()
	store, _ := OpenStore(t.TempDir())
	// The anchors share a clock: a peer's timestamps ahead of it are refused.
	other := &Server{V: &Verifier{Store: store, CA: h.v.CA, Log: h.v.Log, Now: func() time.Time { return h.v.Now() }}, Log: h.v.Log, Peers: []string{peer.URL}, Client: http.DefaultClient}
	get := func(path string) int {
		rr := httptest.NewRecorder()
		other.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		return rr.Code
	}

	// A lookup fills the cache.
	if code := get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("peer lookup: %d", code)
	}
	rec, ok, _ := store.Record("testbox")
	if !ok || rec.LDevIDSerial != serialHex(first) || rec.Status != StatusAttested || !rec.Confirmed || len(rec.EKHashes) != 2 || rec.Class != "worker-g5" {
		t.Fatalf("adopted record %+v %v", rec, ok)
	}
	if code := get("/devid/" + simSerial + "?local=1"); code != http.StatusOK {
		t.Fatalf("local-only lookup after the adoption: %d", code)
	}

	// A renewal on the other anchor reaches this one at the next sync.
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("renew: %v", err)
	}
	other.SyncPeers(context.Background())
	renewed, _, _ := store.Record("testbox")
	if renewed.LDevIDSerial == serialHex(first) || !renewed.LDevIDNotAfter.After(first.NotAfter) || !renewed.Renewed {
		t.Fatalf("record after the sync %+v", renewed)
	}
	metrics, _ := other.V.Metrics()
	if !strings.Contains(metrics, fmt.Sprintf(`talos_attest_ldevid_expiry_timestamp_seconds{machine="testbox"} %d`, renewed.LDevIDNotAfter.Unix())) {
		t.Fatalf("metrics after the sync:\n%s", metrics)
	}

	// A forged peer: the victim's certificates swapped for ones another CA
	// issued for the same keys, and the AK blob swapped for the LDevID's.
	// Nothing of it is adopted, and no renewal is opened on it.
	real := h.devID(t, simSerial)
	foreign := devIDCA(t)
	foreign.Site = "folly"
	ldevidCert, _ := x509.ParseCertificate(mustDER(t, real.LDevIDCert))
	lakCert, _ := x509.ParseCertificate(mustDER(t, real.LAKCert))
	subject := Subject{Machine: "testbox", Serial: simSerial, Class: "worker-g5"}
	forgedLDevID, _ := foreign.Issue(ldevidCert.PublicKey, subject, "LDevID", time.Now())
	forgedLAK, _ := foreign.Issue(lakCert.PublicKey, subject, "LAK", time.Now())
	forged := real
	forged.LDevIDCert, forged.LAKCert, forged.Chain = string(foreign.LeafPEM(forgedLDevID)), string(foreign.LeafPEM(forgedLAK)), string(foreign.ChainPEM())
	// A moment newer than the real renewal, within the slack a peer's clock is allowed.
	newer := h.v.Now().Add(time.Minute)
	forged.AttestedAt = newer
	forged.EKHashes, forged.EKHashesByAlg = []string{strings.Repeat("e", 64)}, map[string]string{"rsa": strings.Repeat("e", 64)}
	swapped := real
	swapped.AKPublic, swapped.AKPrivate = real.LDevIDPublic, real.LDevIDPrivate
	swapped.AttestedAt = newer
	future := real
	future.AttestedAt = h.v.Now().Add(2 * time.Hour)
	for name, bad := range map[string]protocol.DevID{"another CA": forged, "swapped blobs": swapped, "from the future": future} {
		liar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasPrefix(r.URL.Path, "/verdict/"):
				writeJSON(w, http.StatusOK, protocol.Status{Status: protocol.StatusAttested, Node: "testbox", AttestedAt: bad.AttestedAt, UpdatedAt: bad.AttestedAt})
			default:
				writeJSON(w, http.StatusOK, bad)
			}
		}))
		victim := &Server{V: &Verifier{Store: store, CA: h.v.CA, Log: h.v.Log, Now: func() time.Time { return h.v.Now() }, SessionTTL: time.Minute, Inventory: h.v.Inventory, Audit: h.v.Audit}, Log: h.v.Log, Peers: []string{liar.URL}, Client: http.DefaultClient}
		before, _, _ := store.Record("testbox")
		victim.SyncPeers(context.Background())
		if after, _, _ := store.Record("testbox"); after.LDevIDSerial != before.LDevIDSerial || !after.UpdatedAt.Equal(before.UpdatedAt) {
			t.Fatalf("%s: the forged answer was adopted: %+v", name, after)
		}
		// A renewal opened here runs on this anchor's own verified record, never on the liar's.
		rr := httptest.NewRecorder()
		victim.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathRenew, strings.NewReader(`{"serial":"`+simSerial+`"}`)))
		if rr.Code != http.StatusOK {
			t.Fatalf("%s: a renewal on the anchor's own record: %d %s", name, rr.Code, rr.Body.String())
		}
		if after, _, _ := store.Record("testbox"); after.Status != StatusAttested || after.LDevIDSerial != before.LDevIDSerial {
			t.Fatalf("%s: the forged peer changed the record: %+v", name, after)
		}
		liar.Close()
	}
	// VerifyDevID itself refuses each forgery, with the real one passing.
	if _, err := h.v.VerifyDevID(real, "testbox", simSerial); err != nil {
		t.Fatalf("the real DevID: %v", err)
	}
	for name, bad := range map[string]protocol.DevID{"another CA": forged, "swapped blobs": swapped} {
		if _, err := h.v.VerifyDevID(bad, "testbox", simSerial); err == nil {
			t.Fatalf("%s passed VerifyDevID", name)
		}
	}

	// A quarantine on another anchor is not taken from it: NetBox carries
	// quarantines, and a peer's word alone withdraws nothing here.
	h.v.Policy.RenewRequiredAuthorities = []string{strings.Repeat("0", 64)}
	if _, err := h.renew(simSerial); err == nil {
		t.Fatal("a renewal against an unmeetable policy passed")
	}
	other.SyncPeers(context.Background())
	if q, _, _ := store.Record("testbox"); q.Status != StatusAttested {
		t.Fatalf("record after the peer's quarantine %+v", q)
	}
	if code := get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("a peer's quarantine gated this anchor's DevID: %d", code)
	}
}
