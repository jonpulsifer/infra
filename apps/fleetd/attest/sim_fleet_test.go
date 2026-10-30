//go:build cgo

// The fleet flows on the software TPM: a planned machine admitted by its EK
// certificates, NetBox as the system of record from first sight to
// quarantine, and a renewal from the running node.
package attest

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

func emptyInventory(_, _ string) string { return "machines: {}\n" }

// waitFor polls until ok returns true: the recorders write NetBox after the
// verdict is sent.
func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// settled waits until the service has written the device n times, so a
// test's own edit is not overwritten by a write still in flight.
func (f *fakeNetBox) settled(t *testing.T, serial string, n int) *fakeDevice {
	t.Helper()
	waitFor(t, fmt.Sprintf("%d writes to %s", n, serial), func() bool { return f.bySerial(serial).Patches >= n })
	return f.bySerial(serial)
}

func (h *harness) devID(t *testing.T, serial string) protocol.DevID {
	t.Helper()
	code, body := h.get("/devid/" + serial)
	if code != http.StatusOK {
		t.Fatalf("GET /devid: %d %s", code, body)
	}
	var d protocol.DevID
	if err := json.Unmarshal(body, &d); err != nil {
		t.Fatal(err)
	}
	return d
}

// renew drives the renewal client as the tpm-reattest DaemonSet does, with
// the LDevID in NV due for renewal, trusting the DevID CA and keeping the
// service's clock, so a certificate it issues is valid to the client.
func (h *harness) renew(serial string) (*client.RenewResult, error) {
	roots := x509.NewCertPool()
	roots.AddCert(h.v.CA.Cert)
	return client.Renew(context.Background(), h.sim, client.RenewConfig{
		BaseURL:     h.ts.URL,
		Serial:      serial,
		EventLog:    h.eventLog,
		Roots:       roots,
		Now:         h.v.Now,
		RenewBefore: 10 * 365 * 24 * time.Hour,
	})
}

func refusal(t *testing.T, err error) *client.RefusedError {
	t.Helper()
	var refused *client.RefusedError
	if !errors.As(err, &refused) {
		t.Fatalf("got %v, want a refusal", err)
	}
	return refused
}

// A planned machine, entered before it arrived, needs no click when its EKs
// carry manufacturer certificates; its first pass pins it.
func TestPlannedMachineIsAdmittedByItsEKCertificates(t *testing.T) {
	// One software TPM at a time: each subtest's harness closes before the next opens.
	t.Run("pinned by the pass", func(t *testing.T) {
		f := newFakeNetBox(t)
		h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
		f.add("testbox", simSerial, "planned", simMAC, map[string]any{"talos_class": "worker-g5"})
		res, err := h.run(simSerial, simMAC)
		if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
			t.Fatalf("planned machine: %v", err)
		}
		a, _ := h.v.Store.Approvals()
		if len(a[simSerial]) != 2 {
			t.Fatalf("the pass did not pin the EKs: %v", a)
		}
		if d := f.bySerial(simSerial); d.Status != "planned" || d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != h.hashes["ecc"] {
			t.Fatalf("NetBox after the pass: %s %+v", d.Status, d.CustomFields)
		}
	})
	// From an unpinned maker the supply chain says nothing, and the chain check refuses.
	t.Run("unpinned maker", func(t *testing.T) {
		f := newFakeNetBox(t)
		h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f, foreignMfr: true})
		f.add("testbox", simSerial, "planned", simMAC, nil)
		if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonEKChain {
			t.Fatalf("planned with an unpinned maker: %+v", r.Verdict)
		}
	})
	// A NetBox that lacks the machine grants nothing: the claim waits for approval.
	t.Run("absent from NetBox waits for approval", func(t *testing.T) {
		f := newFakeNetBox(t)
		h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
		if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Verdict != protocol.VerdictPending {
			t.Fatalf("absent from NetBox: %+v", r.Verdict)
		}
		if f.count() != 0 {
			t.Fatal("a device was created for a claim")
		}
	})
}

// When NetBox is configured and does not answer, nothing is created and
// nothing passes: the request is refused without a record.
func TestNetBoxOutageFailsClosed(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.setFailing(true, false)
	r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }())
	if r.Status != http.StatusServiceUnavailable || r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != reasonNetBox {
		t.Fatalf("during the outage: %d %+v", r.Status, r.Verdict)
	}
	if f.count() != 0 {
		t.Fatalf("a device was created during the outage")
	}
	if _, ok, _ := h.v.Store.Record("testbox"); ok {
		t.Fatal("the outage wrote a record")
	}
	// Once NetBox holds the machine and fails again, the answer is the same.
	f.setFailing(false, false)
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"ek_hash": h.hashes["rsa"], "ek_hash_ecc": h.hashes["ecc"]})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatalf("after the outage: %v", err)
	}
	f.setFailing(true, false)
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonNetBox {
		t.Fatalf("during a second outage: %+v", r.Verdict)
	}
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusAttested {
		t.Fatalf("the outage changed the record: %+v", rec)
	}
}

// A quarantine whose NetBox write fails still withdraws: the anchors' newer
// quarantine beats the pass NetBox still shows.
func TestFailedNetBoxWriteFailsClosed(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"ek_hash": h.hashes["rsa"], "ek_hash_ecc": h.hashes["ecc"]})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	f.setFailing(false, true)
	h.tamper = func(r *protocol.EvidenceRequest) { r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("tampered boot: %+v", r.Verdict)
	}
	if d := f.bySerial(simSerial); d.Status != "planned" || d.CustomFields["attest_verdict"] != StatusAttested {
		t.Fatalf("the failing write landed: %s %+v", d.Status, d.CustomFields)
	}
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"quarantined"`) {
		t.Fatalf("verdict with NetBox stale: %d %s", code, body)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusForbidden {
		t.Fatalf("DevID with NetBox stale: %d", code)
	}
}

// NetBox is the system of record: first sight creates the device, the owner
// approves, the pass writes the pins and the verdict, the verdict route reads
// NetBox, a quarantine fails the device, and a retired device gets nothing.
func TestNetBoxIsTheSystemOfRecord(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})

	// First sight: NetBox has no device, and a claim creates none. The claim
	// waits apart from the records for the owner.
	r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }())
	if r.Verdict.Verdict != protocol.VerdictPending {
		t.Fatalf("first sight: %+v", r.Verdict)
	}
	if f.count() != 0 {
		t.Fatalf("a claim created %d devices", f.count())
	}
	if p, ok, _ := h.v.Store.Pending(simSerial); !ok || p.Machine != "testbox" || p.EKHashes["rsa"] != h.hashes["rsa"] {
		t.Fatalf("pending claim %+v %v", p, ok)
	}
	if code, _ := h.get("/verdict/" + simSerial); code != http.StatusNotFound {
		t.Fatalf("a pending device's verdict answered %d", code)
	}

	// The owner approves on the admin API.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/approve", strings.NewReader(`{"serial":"`+simSerial+`","ek_hashes":["`+h.hashes["rsa"]+`","`+h.hashes["ecc"]+`"]}`))
	req.Header.Set("Tailscale-User-Login", "owner@example.com")
	h.srv.Admin().ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "NetBox") {
		t.Fatalf("approve: %d %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(h.audit.String(), `"status":"approved","approver":"owner@example.com"`) {
		t.Fatalf("no audit line for the approval:\n%s", h.audit.String())
	}
	// The approved machine activates its credential, and only then does its
	// device come into being, from the SMBIOS facts it sent; the pass follows.
	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("after approval: %v", err)
	}
	if _, ok, _ := h.v.Store.Pending(simSerial); ok {
		t.Fatal("the claim still waits after the pass")
	}
	d := f.settled(t, simSerial, 2)
	if d.Name != "testbox" || d.Status != "planned" || d.CustomFields["sku"] != "TB-1" || d.CustomFields["attest_verdict"] != StatusAttested ||
		d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != h.hashes["ecc"] || d.CustomFields["ldevid_serial"] == "" || f.count() != 1 {
		t.Fatalf("after the pass: %s %+v (%d devices)", d.Status, d.CustomFields, f.count())
	}
	// The LDevID carries the class NetBox holds, once the owner sets one.
	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["talos_class"] = "worker-g5" })
	res, err = h.run(simSerial, simMAC)
	if err != nil {
		t.Fatalf("with a class: %v", err)
	}
	ldevid, _ := x509.ParseCertificate(res.Verdict.LDevIDCert)
	if strings.Join(ldevid.Subject.OrganizationalUnit, ",") != "worker-g5" {
		t.Fatalf("LDevID subject %s", ldevid.Subject)
	}
	f.settled(t, simSerial, 4)

	// The verdict route answers from NetBox, with the anchors' UUID for the same attestation.
	code, body := h.get("/verdict/" + simSerial)
	var st protocol.Status
	if err := json.Unmarshal(body, &st); err != nil || code != http.StatusOK || st.Status != protocol.StatusAttested || st.Node != "testbox" || st.Class != "worker-g5" || st.Site != "folly" || st.UUID != simClaim.UUID || !st.RSAEKCert {
		t.Fatalf("GET /verdict from NetBox: %d %s", code, body)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("GET /devid after a NetBox-recorded pass: %d", code)
	}

	// NetBox's pins now gate the next attest: a changed pin refuses, and
	// since nothing the TPM signed led there, NetBox is untouched.
	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["ek_hash"] = strings.Repeat("ab", 32) })
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonEKHash || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("NetBox pin mismatch: %+v", r.Verdict)
	}
	if d := f.bySerial(simSerial); d.Patches != 4 || d.Status != "planned" || d.CustomFields["attest_verdict"] != StatusAttested {
		t.Fatalf("a refusal wrote to NetBox: %d writes, %s %+v", d.Patches, d.Status, d.CustomFields)
	}
	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["ek_hash"] = h.hashes["rsa"] })

	// A boot the TPM vouches for that breaks the policy quarantines: NetBox records
	// the verdict, the status stays, and the anchors serve no LDevID.
	h.tamper = func(r *protocol.EvidenceRequest) { r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonEventLog || r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("tampered boot evidence: %+v", r.Verdict)
	}
	h.tamper = nil
	if d := f.settled(t, simSerial, 5); d.Status != "planned" || d.CustomFields["attest_verdict"] != "quarantined: "+reasonEventLog {
		t.Fatalf("after the quarantine: %s %+v", d.Status, d.CustomFields)
	}
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"quarantined"`) {
		t.Fatalf("quarantined verdict: %d %s", code, body)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusForbidden {
		t.Fatalf("a quarantined device's DevID answered %d", code)
	}

	// Lifting the quarantine is the owner's: until then, no attest and no renewal.
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonStatus || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("attest while quarantined: %+v", r.Verdict)
	}
	rr = httptest.NewRecorder()
	h.srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathRenew, strings.NewReader(`{"serial":"`+simSerial+`"}`)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("renewal while quarantined: %d %s", rr.Code, rr.Body.String())
	}
	if d := f.bySerial(simSerial); d.Patches != 5 || d.Status != "planned" {
		t.Fatalf("a refusal while quarantined wrote to NetBox: %d writes, %s", d.Patches, d.Status)
	}
	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["attest_verdict"] = "" })
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatalf("after the owner cleared the verdict: %v", err)
	}
	if d := f.settled(t, simSerial, 7); d.Status != "planned" || d.CustomFields["attest_verdict"] != StatusAttested {
		t.Fatalf("after the second pass: %s %+v", d.Status, d.CustomFields)
	}

	// A retired device gets no identity at all, and the refusal leaves it
	// retired: nothing pulls it back into the export.
	f.set(simSerial, func(d *fakeDevice) { d.Status = "offline" })
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonStatus || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("retired: %+v", r.Verdict)
	}
	rr = httptest.NewRecorder()
	h.srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathRenew, strings.NewReader(`{"serial":"`+simSerial+`"}`)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("renewal while retired: %d %s", rr.Code, rr.Body.String())
	}
	if d := f.bySerial(simSerial); d.Status != "offline" || d.Patches != 7 {
		t.Fatalf("a status refusal wrote to NetBox: %s after %d writes", d.Status, d.Patches)
	}

	// A planned device NetBox already holds passes with no click.
	f.add("swell", "SW-PLANNED", "planned", "02:00:00:00:00:02", map[string]any{"talos_class": "worker-g5"})
	if _, err := h.run("SW-PLANNED", "02:00:00:00:00:02"); err != nil {
		t.Fatalf("planned device in NetBox: %v", err)
	}
	if d := f.settled(t, "SW-PLANNED", 2); d.Status != "planned" || d.CustomFields["ek_hash"] != h.hashes["rsa"] {
		t.Fatalf("planned device after its pass: %s %+v", d.Status, d.CustomFields)
	}
}

// A renewal from the running node: the LAK on file signs a quote, the
// running boot meets the renewal policy, and both certificates roll.
func TestRenewalFromTheRunningNode(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	res, err := h.run(simSerial, simMAC)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := x509.ParseCertificate(res.Verdict.LDevIDCert)
	firstLAK, _ := x509.ParseCertificate(res.Verdict.LAKCert)
	before := h.devID(t, simSerial)

	// The full policy applies to a renewal, minus required_authorities,
	// which only a HookOS boot meets.
	h.v.Policy = loadPolicy(t)
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	renewed, err := h.renew(simSerial)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if !renewed.Renewed || !renewed.NotAfter.After(first.NotAfter) {
		t.Fatalf("renewal result %+v", renewed)
	}
	nv, err := tpm2.NVReadEx(h.sim, tpmutil.Handle(protocol.NVLDevIDCert), tpm2.HandleOwner, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := x509.ParseCertificate(nv)
	if err != nil {
		t.Fatalf("NV after the renewal: %v", err)
	}
	if second.SerialNumber.Cmp(first.SerialNumber) == 0 || !second.NotAfter.After(first.NotAfter) || !bytes.Equal(second.RawSubjectPublicKeyInfo, first.RawSubjectPublicKeyInfo) || second.Subject.String() != first.Subject.String() {
		t.Fatalf("renewed LDevID %s %s vs %s %s", second.SerialNumber, second.NotAfter, first.SerialNumber, first.NotAfter)
	}
	lakNV, _ := tpm2.NVReadEx(h.sim, tpmutil.Handle(protocol.NVLAKCert), tpm2.HandleOwner, "", 0)
	if secondLAK, err := x509.ParseCertificate(lakNV); err != nil || secondLAK.SerialNumber.Cmp(firstLAK.SerialNumber) == 0 {
		t.Fatalf("the LAK did not roll: %v", err)
	}
	rec, _, _ := h.v.Store.Record("testbox")
	if !rec.Renewed || rec.LDevIDSerial != serialHex(second) || rec.Status != StatusAttested || !rec.LDevIDNotAfter.Equal(second.NotAfter) {
		t.Fatalf("record after renewal %+v", rec)
	}
	after := h.devID(t, simSerial)
	if after.LDevIDCert == before.LDevIDCert || !strings.Contains(after.LDevIDCert, "BEGIN CERTIFICATE") || !after.AttestedAt.After(before.AttestedAt) || !bytes.Equal(after.LDevIDPrivate, before.LDevIDPrivate) {
		t.Fatal("GET /devid does not serve the renewed certificate with the blobs on file")
	}
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"attested"`) {
		t.Fatalf("verdict after renewal: %d %s", code, body)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.renew"`) {
		t.Fatalf("no audit line for the renewal:\n%s", h.audit.String())
	}

	// A renewal that fails the renewal policy quarantines the machine.
	h.v.Policy.RenewRequiredAuthorities = h.v.Policy.RequiredAuthorities
	if r := refusal(t, func() error { _, err := h.renew(simSerial); return err }()); r.Verdict.Reason != reasonPolicy {
		t.Fatalf("renewal against the HookOS policy: %+v", r.Verdict)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusForbidden {
		t.Fatalf("a quarantined machine's DevID answered %d", code)
	}
}

// A retired machine gets no renewal, and a serial with nothing on file is
// not found rather than quarantined.
func TestRenewalRefusals(t *testing.T) {
	t.Run("retired", func(t *testing.T) {
		h := newHarness(t, harnessOpts{})
		if _, err := h.run(simSerial, simMAC); err != nil {
			t.Fatal(err)
		}
		h.nb.set(simSerial, func(d *fakeDevice) { d.Status = "decommissioning" })
		rr := httptest.NewRecorder()
		h.srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathRenew, strings.NewReader(`{"serial":"`+simSerial+`"}`)))
		if rr.Code != http.StatusForbidden || !strings.Contains(rr.Body.String(), reasonStatus) {
			t.Fatalf("retired renewal: %d %s", rr.Code, rr.Body.String())
		}
	})
	t.Run("nothing on file", func(t *testing.T) {
		h := newHarness(t, harnessOpts{})
		rr := httptest.NewRecorder()
		h.srv.DevIDHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, protocol.PathRenew, strings.NewReader(`{"serial":"`+simSerial+`"}`)))
		if rr.Code != http.StatusNotFound {
			t.Fatalf("renewal with nothing on file: %d %s", rr.Code, rr.Body.String())
		}
		if _, ok, _ := h.v.Store.Record("testbox"); ok {
			t.Fatal("a refused renewal start quarantined the machine")
		}
	})
}
