//go:build cgo

// A host posing as a peer replays the machine's own genuine, older DevID
// with fresh timestamps. The LDevID's issue time, not the peer's clock,
// orders attestations, so a replay undoes nothing.
package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// replayLiar answers as a peer that holds real, stamped as just updated.
func replayLiar(real protocol.DevID) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/verdict/") {
			writeJSON(w, http.StatusOK, protocol.Status{Status: protocol.StatusAttested, Node: real.Machine, AttestedAt: real.AttestedAt, UpdatedAt: time.Now().Add(time.Minute)})
			return
		}
		writeJSON(w, http.StatusOK, real)
	}))
}

// Inventory mode: this anchor's quarantine stands against a replay of the
// pass it withdrew.
func TestReplayDoesNotUndoAQuarantine(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	real := h.devID(t, simSerial)
	h.tamper = func(r *protocol.EvidenceRequest) { r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("tampered boot: %+v", r.Verdict)
	}
	h.tamper = nil
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusNotFound {
		t.Fatalf("DevID after the quarantine: %d", code)
	}
	liar := replayLiar(real)
	defer liar.Close()
	h.srv.Peers = []string{liar.URL}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusNotFound {
		t.Fatalf("a replayed pass reopened the DevID: %d", code)
	}
	h.srv.SyncPeers(context.Background())
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusQuarantined {
		t.Fatalf("a replayed pass undid the quarantine: %+v", rec)
	}
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"quarantined"`) {
		t.Fatalf("verdict with a replaying peer: %d %s", code, body)
	}
}

// NetBox mode with the quarantine's write failed: the anchor's own
// quarantine still beats both NetBox's stale pass and a peer's replay.
func TestReplayDoesNotUndoAQuarantineNetBoxWriteFailed(t *testing.T) {
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
	real := h.devID(t, simSerial)
	f.setFailing(false, true)
	h.tamper = func(r *protocol.EvidenceRequest) { r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("tampered boot: %+v", r.Verdict)
	}
	h.tamper = nil
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusNotFound {
		t.Fatalf("DevID after the quarantine: %d", code)
	}
	liar := replayLiar(real)
	defer liar.Close()
	h.srv.Peers = []string{liar.URL}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusNotFound {
		t.Fatalf("a replayed pass reopened the DevID with NetBox stale: %d", code)
	}
	h.srv.SyncPeers(context.Background())
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusQuarantined {
		t.Fatalf("a replayed pass undid the quarantine: %+v", rec)
	}
}

// A replay of an older pass is not adopted over a renewal: the issue time
// orders them, whatever the peer's timestamps say, and the older pass
// retires nothing.
func TestReplayedOlderPassIsNotAdoptedOverARenewal(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	old := h.devID(t, simSerial)
	peer := httptest.NewServer(h.srv.DevIDHandler())
	defer peer.Close()
	store, _ := OpenStore(t.TempDir())
	other := &Server{V: &Verifier{Store: store, CA: h.v.CA, Log: h.v.Log, Now: func() time.Time { return h.v.Now() }}, Log: h.v.Log, Peers: []string{peer.URL}, Client: http.DefaultClient}
	other.SyncPeers(context.Background())
	rr := httptest.NewRecorder()
	other.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/devid/"+simSerial, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("first adoption: %d", rr.Code)
	}
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("renew: %v", err)
	}
	other.SyncPeers(context.Background())
	renewed, _, _ := store.Record("testbox")
	if renewed.LDevIDSerial == "" || strings.Contains(old.LDevIDCert, renewed.LDevIDSerial) {
		t.Fatalf("the renewal was not adopted: %+v", renewed)
	}
	liar := replayLiar(old)
	defer liar.Close()
	other.Peers = []string{liar.URL}
	other.SyncPeers(context.Background())
	if after, _, _ := store.Record("testbox"); after.LDevIDSerial != renewed.LDevIDSerial || !after.UpdatedAt.Equal(renewed.UpdatedAt) {
		t.Fatalf("the older pass was adopted over the renewal: %+v", after)
	}
	recs, _ := store.Records()
	if len(recs) != 1 {
		t.Fatalf("%d records after the replay", len(recs))
	}
}
