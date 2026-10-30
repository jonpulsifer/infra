//go:build cgo

// What a request that proved nothing may do (nothing), from the
// verification pass on the fleet work: these stay green.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// junkStart posts a Start for claim, with a fresh software RSA key as an
// EK with no certificate when withEK is set: what anyone on the network
// can send for any serial.
func junkStart(t *testing.T, h *harness, claim protocol.Machine, withEK bool) (int, string) {
	t.Helper()
	req := protocol.StartRequest{Machine: claim}
	if withEK {
		k, _ := rsa.GenerateKey(rand.Reader, 2048)
		der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
		req.EKs = []protocol.EK{{Public: der}}
	}
	b, _ := json.Marshal(req)
	resp, err := http.Post(h.ts.URL+protocol.PathStart, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.String()
}

// A junk EK for a machine whose pins live only in approvals.json is a
// mismatch, refused: it never writes a pending claim over the pass.
func TestJunkStartNeverOverwritesAnAttestedRecord(t *testing.T) {
	h := newHarness(t, harnessOpts{inventory: func(_, _ string) string {
		return fmt.Sprintf("machines:\n  testbox:\n    serial: %s\n    mac: %q\n", simSerial, simMAC)
	}})
	_, _ = h.run(simSerial, simMAC)
	if _, err := h.v.Approve(context.Background(), simSerial, []string{h.hashes["rsa"], h.hashes["ecc"]}, "o"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	before, _, _ := h.v.Store.Record("testbox")
	code, body := junkStart(t, h, simClaim, true)
	if code != http.StatusForbidden || !strings.Contains(body, `"verdict":"refused"`) || !strings.Contains(body, reasonEKHash) {
		t.Fatalf("junk start: %d %s", code, body)
	}
	rec, _, _ := h.v.Store.Record("testbox")
	if rec.Status != StatusAttested || rec.LDevIDSerial != before.LDevIDSerial || !rec.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("the junk start changed the record: %+v", rec)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("the junk start withdrew the DevID: %d", code)
	}
	if _, ok, _ := h.v.Store.Pending(simSerial); ok {
		t.Fatal("the junk start left a pending claim")
	}
}

// A peer that says "quarantined" is not believed: it gates nothing and
// nothing is adopted from it.
func TestPeerQuarantineIsNotBelieved(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	liar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/verdict/") {
			writeJSON(w, http.StatusOK, protocol.Status{Status: protocol.StatusQuarantined, Node: "testbox", UpdatedAt: time.Now().Add(100 * 24 * time.Hour)})
			return
		}
		http.NotFound(w, r)
	}))
	defer liar.Close()
	h.srv.Peers = []string{liar.URL}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("DevID with a lying peer: %d", code)
	}
	h.srv.SyncPeers(context.Background())
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusAttested {
		t.Fatalf("record after the lying peer's sync: %+v", rec)
	}
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"attested"`) {
		t.Fatalf("verdict with a lying peer: %d %s", code, body)
	}
}

// Certificates and blobs swapped as pairs are not a DevID.
func TestRoleSwappedDevIDIsRefused(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	real := h.devID(t, simSerial)
	sw := real
	sw.LDevIDCert, sw.LAKCert = real.LAKCert, real.LDevIDCert
	sw.AKPublic, sw.AKPrivate = real.LDevIDPublic, real.LDevIDPrivate
	sw.LDevIDPublic, sw.LDevIDPrivate = real.AKPublic, real.AKPrivate
	if _, err := h.v.VerifyDevID(sw, "testbox", simSerial); err == nil {
		t.Fatal("a role-swapped DevID passed")
	}
	// A certificate past its validity is not one either.
	h.v.Now = func() time.Time { return time.Now().Add(400 * 24 * time.Hour) }
	if _, err := h.v.VerifyDevID(real, "testbox", simSerial); err == nil {
		t.Fatal("an expired DevID passed")
	}
}

// Junk Starts create nothing in NetBox and spend none of the intake cap;
// the cap counts EKs that activated a credential.
func TestJunkStartsSpendNothing(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.v.IntakePerHour = 2
	for i := 0; i < 10; i++ {
		c := simClaim
		c.Serial, c.Hostname, c.MAC = fmt.Sprintf("JUNK-%d", i), "", ""
		// With an EK the claim waits for the owner; without one it is refused. Neither writes a record.
		want := `"verdict":"refused"`
		if i%2 == 0 {
			want = `"verdict":"pending-approval"`
		}
		if code, body := junkStart(t, h, c, i%2 == 0); code != http.StatusForbidden || !strings.Contains(body, want) {
			t.Fatalf("junk start %d: %d %s", i, code, body)
		}
	}
	if recs, _ := h.v.Store.Records(); len(recs) != 0 {
		t.Fatalf("junk starts wrote %d machine records", len(recs))
	}
	if f.count() != 0 {
		t.Fatalf("junk starts created %d devices", f.count())
	}
	if pendings, _ := h.v.Store.Pendings(); len(pendings) != 5 {
		t.Fatalf("%d claims wait; the five with an EK should", len(pendings))
	}
	// A real machine still gets through: its claim waits, the owner approves,
	// activation creates its device.
	r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }())
	if r.Verdict.Verdict != protocol.VerdictPending {
		t.Fatalf("legit first intake: %+v", r.Verdict)
	}
	if _, err := h.v.Approve(context.Background(), simSerial, []string{h.hashes["rsa"], h.hashes["ecc"]}, "o"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatalf("after approval: %v", err)
	}
	if f.count() != 1 {
		t.Fatalf("%d devices after the real intake", f.count())
	}
	// The same EK again spends nothing more.
	if !h.v.admitIntake(time.Now(), h.hashes["ecc"]) || !h.v.admitIntake(time.Now(), "other") || h.v.admitIntake(time.Now(), "third") {
		t.Fatal("the cap does not count distinct EKs")
	}
}

// A claimed hostname equal to another machine's name touches nothing: the
// claim waits under its own serial, and the machine's record stands.
func TestClaimedHostnameNeverOverwritesARecord(t *testing.T) {
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
	f.set(simSerial, func(d *fakeDevice) { d.Name = "testbox2" })
	c := simClaim
	c.Serial, c.Hostname, c.MAC = "EVIL-1", "testbox", ""
	code, body := junkStart(t, h, c, true)
	if code != http.StatusForbidden || !strings.Contains(body, protocol.VerdictPending) {
		t.Fatalf("junk start: %d %s", code, body)
	}
	rec, ok, _ := h.v.Store.Record("testbox")
	if !ok || rec.Serial != simSerial || rec.Status != StatusAttested {
		t.Fatalf("testbox's record after the claim: %+v %v", rec, ok)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("the claim withdrew the DevID: %d", code)
	}
	if p, ok, _ := h.v.Store.Pending("EVIL-1"); !ok || p.Machine != "testbox" {
		t.Fatalf("the claim waits under its own serial: %+v %v", p, ok)
	}
	if f.count() != 1 {
		t.Fatalf("the claim created a device: %d devices", f.count())
	}
	// A serial that is not printable ASCII is 400 before any lookup.
	c.Serial = "sér/ial"
	if code, _ := junkStart(t, h, c, true); code != http.StatusBadRequest {
		t.Fatalf("a non-ASCII serial answered %d", code)
	}
	c.Serial = ""
	if code, _ := junkStart(t, h, c, true); code != http.StatusBadRequest {
		t.Fatalf("an empty serial answered %d", code)
	}
}
