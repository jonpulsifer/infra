//go:build cgo

// The daily check on the software TPM: a running node's LAK-signed quote,
// judged by the renewal policy, recorded in NetBox as a verdict and a time,
// with nothing issued. Each case below says whether it may quarantine.
package attest

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/tpmutil"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// check drives the client as the tpm-reattest DaemonSet does on a day no
// renewal is due.
func (h *harness) check(baseURL, bios string) (*client.RenewResult, error) {
	roots := x509.NewCertPool()
	roots.AddCert(h.v.CA.Cert)
	return client.Renew(context.Background(), h.sim, client.RenewConfig{
		BaseURL:     baseURL,
		Serial:      simSerial,
		EventLog:    h.eventLog,
		Roots:       roots,
		Now:         h.v.Now,
		RenewBefore: time.Hour,
		Check:       true,
		BIOS:        bios,
	})
}

// activeNode is a node that passed intake and runs: NetBox holds it active,
// with the pcr0_by_bios field defined and empty.
func activeNode(t *testing.T) (*harness, *fakeNetBox) {
	t.Helper()
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{netbox: f})
	f.add("testbox", simSerial, "active", simMAC, map[string]any{"talos_class": "worker-g5", "pcr0_by_bios": nil, "ek_hash": h.hashes["rsa"], "ek_hash_ecc": h.hashes["ecc"]})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	f.settled(t, simSerial, 2)
	return h, f
}

func nvLDevID(t *testing.T, h *harness) *x509.Certificate {
	t.Helper()
	b, err := tpm2.NVReadEx(h.sim, tpmutil.Handle(protocol.NVLDevIDCert), tpm2.HandleOwner, "", 0)
	if err != nil {
		t.Fatal(err)
	}
	c, err := x509.ParseCertificate(b)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func simPCR0(t *testing.T, h *harness) string {
	t.Helper()
	v, err := tpm2.ReadPCR(h.sim, 0, tpm2.AlgSHA256)
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(v)
}

// untouched fails when anything wrote to the device or the anchor's record
// since the snapshot: a refusal records nothing.
func untouched(t *testing.T, h *harness, f *fakeNetBox, before *fakeDevice, rec Record) {
	t.Helper()
	// A late write would come from a recorder goroutine; give it the chance.
	time.Sleep(100 * time.Millisecond)
	d := f.bySerial(simSerial)
	if d.Patches != before.Patches || d.Status != before.Status || d.CustomFields["attest_verdict"] != before.CustomFields["attest_verdict"] || d.CustomFields["last_attested"] != before.CustomFields["last_attested"] {
		t.Fatalf("a refusal wrote to NetBox: %d writes (was %d), %s %+v", d.Patches, before.Patches, d.Status, d.CustomFields)
	}
	now, _, _ := h.v.Store.Record("testbox")
	if now.Status != rec.Status || !now.UpdatedAt.Equal(rec.UpdatedAt) || !now.CheckedAt.Equal(rec.CheckedAt) {
		t.Fatalf("a refusal changed the anchor's record: %+v, was %+v", now, rec)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("after a refusal GET /devid answered %d", code)
	}
}

func snapshot(t *testing.T, h *harness, f *fakeNetBox) (*fakeDevice, Record) {
	t.Helper()
	rec, ok, err := h.v.Store.Record("testbox")
	if err != nil || !ok {
		t.Fatalf("no record: %v", err)
	}
	return f.bySerial(simSerial), rec
}

// A passing check records the verdict and its time, and nothing else: no
// certificate is issued, NV is untouched, and the device keeps its status
// and serials.
func TestDailyCheckPasses(t *testing.T) {
	h, f := activeNode(t)
	first := nvLDevID(t, h)
	before := f.bySerial(simSerial)
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }

	res, err := h.check(h.ts.URL, "1.0")
	if err != nil {
		t.Fatalf("check: %v", err)
	}
	if !res.Checked || res.Renewed || res.AttestedAt.IsZero() {
		t.Fatalf("check result %+v", res)
	}
	if after := nvLDevID(t, h); after.SerialNumber.Cmp(first.SerialNumber) != 0 {
		t.Fatal("a check replaced the LDevID in NV")
	}
	d := f.settled(t, simSerial, 3)
	if d.Status != "active" || d.CustomFields["attest_verdict"] != StatusAttested || d.CustomFields["ldevid_serial"] != before.CustomFields["ldevid_serial"] || d.CustomFields["lak_serial"] != before.CustomFields["lak_serial"] {
		t.Fatalf("NetBox after the check: %s %+v", d.Status, d.CustomFields)
	}
	if d.CustomFields["last_attested"] == before.CustomFields["last_attested"] || d.CustomFields["last_attested"] != res.AttestedAt.UTC().Format(time.RFC3339) {
		t.Fatalf("last_attested %v, was %v, check %s", d.CustomFields["last_attested"], before.CustomFields["last_attested"], res.AttestedAt)
	}
	rec, _, _ := h.v.Store.Record("testbox")
	if rec.Status != StatusAttested || rec.CheckedAt.IsZero() || rec.LDevIDSerial != serialHex(first) || rec.LDevIDNotBefore.IsZero() {
		t.Fatalf("record after the check %+v", rec)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.check","site":"folly","node":"testbox","serial":"`+simSerial+`"`) || !strings.Contains(h.audit.String(), `"status":"pass"`) {
		t.Fatalf("no audit line for the check:\n%s", h.audit.String())
	}
	m, _ := h.v.Metrics()
	for _, want := range []string{
		`talos_attest_checks_total{machine="testbox",verdict="pass"} 1`,
		`talos_attest_last_checked_timestamp_seconds{machine="testbox"} ` + strconv.FormatInt(rec.CheckedAt.Unix(), 10),
		`talos_attest_pcr0_changed{machine="testbox"} 0`,
	} {
		if !strings.Contains(m, want) {
			t.Fatalf("metrics lack %q:\n%s", want, m)
		}
	}
	// NetBox's last_attested moved and no certificate did: the anchors bind
	// a verdict to the LDevID they serve by its serial, so the DevID is still
	// served, here and by an anchor whose record predates the check.
	code, body := h.get("/verdict/" + simSerial)
	var st protocol.Status
	if err := json.Unmarshal(body, &st); err != nil || code != http.StatusOK || st.LDevIDSerial != serialHex(first) {
		t.Fatalf("GET /verdict after the check: %d %s", code, body)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("GET /devid after the check: %d", code)
	}
	older := rec
	older.AttestedAt = rec.AttestedAt.Add(-2 * time.Hour)
	if err := h.v.Store.Save(older, nil); err != nil {
		t.Fatal(err)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("GET /devid from an anchor whose record predates the check: %d", code)
	}
}

// A boot the TPM vouches for, after the LAK signed the quote and certified
// the LDevID key on file, that misses the renewal policy quarantines the
// node: NetBox goes failed, which puts it on the bootstrap VLAN.
func TestDailyCheckQuarantinesAPolicyMiss(t *testing.T) {
	t.Run("policy", func(t *testing.T) {
		h, f := activeNode(t)
		// The HookOS key, which a disk boot of Talos never shows.
		h.v.Policy.RenewRequiredAuthorities = loadPolicy(t).RequiredAuthorities
		r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }())
		if r.Status != http.StatusForbidden || r.Verdict.Verdict != protocol.VerdictQuarantine || r.Verdict.Reason != reasonPolicy {
			t.Fatalf("policy miss: %+v", r)
		}
		quarantined(t, h, f, reasonPolicy)
	})
	// The event log is the node's account of the boot; one that does not
	// replay to the PCRs the TPM quoted is a lie about it.
	t.Run("event log", func(t *testing.T) {
		h, f := activeNode(t)
		h.tamperRenew = func(_ string, e *protocol.RenewEvidence) { e.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
		r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }())
		if r.Verdict.Verdict != protocol.VerdictQuarantine || r.Verdict.Reason != reasonEventLog {
			t.Fatalf("lying event log: %+v", r)
		}
		quarantined(t, h, f, reasonEventLog)
	})
}

// The owner lifts an active node's quarantine by clearing its verdict in
// NetBox. Until then nothing changes; afterwards the next check that proves
// the LAK, the LDevID key and the boot replaces the anchor's quarantined
// record, and the LDevID is served again. A check that misses the policy
// after the lift quarantines it again.
func TestOwnerLiftsAQuarantineOnAnActiveNode(t *testing.T) {
	h, f := activeNode(t)
	before := nvLDevID(t, h)
	policy := h.v.Policy.RenewRequiredAuthorities
	h.v.Policy.RenewRequiredAuthorities = loadPolicy(t).RequiredAuthorities
	if r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("policy miss: %+v", r)
	}
	quarantined(t, h, f, reasonPolicy)
	h.v.Policy.RenewRequiredAuthorities = policy

	// A good boot changes nothing while the verdict stands.
	if _, err := h.check(h.ts.URL, "1.0"); err == nil {
		t.Fatal("a check passed before the owner lifted the quarantine")
	}

	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["attest_verdict"] = "" })
	// The node gets its key blobs to prove itself with; the files SPIRE
	// reads wait for the proof.
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("the lifted node's DevID answered %d before a check", code)
	}
	if code, _ := h.get("/devid/" + simSerial + "/" + fileLDevIDCert); code == http.StatusOK {
		t.Fatal("the lifted node's LDevID file was served before a check")
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || rec.Status != StatusQuarantined {
		t.Fatalf("the lift alone replaced the quarantine: %+v", rec)
	}
	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatalf("the first check after the lift: %v", err)
	}
	if d := f.settled(t, simSerial, 4); d.Status != "active" || d.CustomFields["attest_verdict"] != StatusAttested {
		t.Fatalf("NetBox after the lift: %s %+v", d.Status, d.CustomFields)
	}
	rec, ok, err := h.v.Store.Record("testbox")
	if err != nil || !ok || rec.Status != StatusAttested || len(rec.EKHashes) == 0 || !strings.EqualFold(rec.LDevIDSerial, serialHex(before)) {
		t.Fatalf("the anchor's record after the lift: %+v %v", rec, err)
	}
	if code, body := h.get("/devid/" + simSerial + "/" + fileLDevIDCert); code != http.StatusOK || !strings.Contains(string(body), "BEGIN CERTIFICATE") {
		t.Fatalf("the lifted node's LDevID file: %d %s", code, body)
	}
	if after := nvLDevID(t, h); !after.Equal(before) {
		t.Fatal("a check issued a new LDevID")
	}

	// The lift restores the identity, not a free pass: a miss quarantines again.
	h.v.Policy.RenewRequiredAuthorities = loadPolicy(t).RequiredAuthorities
	if r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("a miss after the lift: %+v", r)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusForbidden {
		t.Fatalf("the requarantined node's DevID answered %d", code)
	}
}

// Clearing the verdict lifts nothing without a proof: forged evidence for
// the lifted serial is refused and leaves the anchor's quarantine in place.
func TestALiftedQuarantineStillNeedsTheProof(t *testing.T) {
	h, f := activeNode(t)
	policy := h.v.Policy.RenewRequiredAuthorities
	h.v.Policy.RenewRequiredAuthorities = loadPolicy(t).RequiredAuthorities
	if r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("policy miss: %+v", r)
	}
	h.v.Policy.RenewRequiredAuthorities = policy
	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["attest_verdict"] = "" })
	h.tamperRenew = func(_ string, e *protocol.RenewEvidence) {
		e.Quote.Signature = append([]byte{}, e.Quote.Signature[:len(e.Quote.Signature)-1]...)
	}
	if r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }()); r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("forged evidence after the lift: %+v", r)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || rec.Status != StatusQuarantined {
		t.Fatalf("forged evidence replaced the quarantine: %+v", rec)
	}
	if code, _ := h.get("/devid/" + simSerial + "/" + fileLDevIDCert); code == http.StatusOK {
		t.Fatal("forged evidence reopened the LDevID file")
	}
}

// The control plane is never quarantined by a running quote: failing
// folly's only control plane would move the cluster's API to the bootstrap
// VLAN. Its failure is recorded, journaled and alerts; status and LDevID stay.
func TestControlPlaneFailsInPlace(t *testing.T) {
	t.Run("daily check", func(t *testing.T) {
		h, f := activeNode(t)
		f.set(simSerial, func(d *fakeDevice) { d.CustomFields["talos_class"] = "controlplane" })
		h.v.Policy.RenewRequiredAuthorities = loadPolicy(t).RequiredAuthorities
		r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }())
		if r.Status != http.StatusForbidden || r.Verdict.Verdict != protocol.VerdictFailedNoQuarantine || r.Verdict.Reason != reasonPolicy {
			t.Fatalf("control-plane policy miss: %+v", r)
		}
		failedInPlace(t, h, f, 3)
		if !strings.Contains(h.audit.String(), `"event":"attest.check"`) {
			t.Fatalf("no attest.check audit line:\n%s", h.audit.String())
		}
		if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_checks_total{machine="testbox",verdict="failed-no-quarantine"} 1`) {
			t.Fatalf("metrics lack the check verdict:\n%s", m)
		}

		// The next passing check clears it.
		h.v.Policy.RenewRequiredAuthorities = nil
		if _, err := h.check(h.ts.URL, "1.0"); err != nil {
			t.Fatalf("check after the boot is fixed: %v", err)
		}
		if d := f.settled(t, simSerial, 4); d.Status != "active" || d.CustomFields["attest_verdict"] != StatusAttested {
			t.Fatalf("NetBox after the passing check: %s %+v", d.Status, d.CustomFields)
		}
		if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_failed_no_quarantine{machine="testbox"} 0`) {
			t.Fatalf("the passing check did not clear the failure:\n%s", m)
		}
	})
	t.Run("renewal", func(t *testing.T) {
		h, f := activeNode(t)
		f.set(simSerial, func(d *fakeDevice) { d.CustomFields["talos_class"] = "controlplane" })
		first := nvLDevID(t, h)
		h.v.Policy.RenewRequiredAuthorities = loadPolicy(t).RequiredAuthorities
		r := refusal(t, func() error { _, err := h.renew(simSerial); return err }())
		if r.Verdict.Verdict != protocol.VerdictFailedNoQuarantine || r.Verdict.Reason != reasonPolicy {
			t.Fatalf("control-plane renewal policy miss: %+v", r)
		}
		failedInPlace(t, h, f, 3)
		if after := nvLDevID(t, h); after.SerialNumber.Cmp(first.SerialNumber) != 0 {
			t.Fatal("a failed renewal replaced the LDevID in NV")
		}
	})
}

func failedInPlace(t *testing.T, h *harness, f *fakeNetBox, patches int) {
	t.Helper()
	d := f.settled(t, simSerial, patches)
	if d.Status != "active" || d.CustomFields["attest_verdict"] != "failed-no-quarantine: "+reasonPolicy {
		t.Fatalf("NetBox after a control-plane failure: %s %+v", d.Status, d.CustomFields)
	}
	waitFor(t, "the failure's journal entry", func() bool {
		return f.journaled("danger: fleetd: failed attestation (policy) and not quarantined")
	})
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusAttested || rec.CheckFailed != reasonPolicy {
		t.Fatalf("record after a control-plane failure: %+v", rec)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
		t.Fatalf("a control-plane node lost its DevID: %d", code)
	}
	if code, body := h.get("/verdict/" + simSerial); code != http.StatusOK || !strings.Contains(string(body), `"status":"attested"`) {
		t.Fatalf("verdict after a control-plane failure: %d %s", code, body)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_failed_no_quarantine{machine="testbox"} 1`) {
		t.Fatalf("metrics lack the failure:\n%s", m)
	}
	if !strings.Contains(h.audit.String(), `"status":"failed-no-quarantine"`) {
		t.Fatalf("no audit line for the failure:\n%s", h.audit.String())
	}
}

func quarantined(t *testing.T, h *harness, f *fakeNetBox, reason string) {
	t.Helper()
	if d := f.settled(t, simSerial, 3); d.Status != "active" || d.CustomFields["attest_verdict"] != "quarantined: "+reason {
		t.Fatalf("NetBox after the quarantine: %s %+v", d.Status, d.CustomFields)
	}
	if code, _ := h.get("/devid/" + simSerial); code != http.StatusForbidden {
		t.Fatalf("a quarantined node's DevID answered %d", code)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.check"`) || !strings.Contains(h.audit.String(), `"status":"quarantine"`) {
		t.Fatalf("no audit line for the quarantine:\n%s", h.audit.String())
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_checks_total{machine="testbox",verdict="quarantine"} 1`) {
		t.Fatalf("metrics lack the quarantine:\n%s", m)
	}
	// Lifting the quarantine is the owner's: a quarantined node's next check finds
	// no DevID to sign with, its start is refused, and neither writes.
	if _, err := h.check(h.ts.URL, "1.0"); err == nil {
		t.Fatal("a check while quarantined passed")
	}
	if code, body := h.post(protocol.PathRenew, protocol.RenewRequest{Serial: simSerial, Check: true}); code != http.StatusForbidden || !strings.Contains(string(body), reasonStatus) {
		t.Fatalf("a check start while quarantined: %d %s", code, body)
	}
	if d := f.bySerial(simSerial); d.Patches != 3 || d.Status != "active" {
		t.Fatalf("a check while quarantined wrote to NetBox: %d writes, %s", d.Patches, d.Status)
	}
}

// Before the proof nothing is recorded: evidence the LAK on file did not
// sign over this session's nonce, or that does not certify the LDevID key
// on file, is a refusal, so nobody quarantines a node by its public serial.
func TestDailyCheckRefusesUnprovenEvidence(t *testing.T) {
	cases := []struct {
		name   string
		reason string
		tamper func(t *testing.T, h *harness, e *protocol.RenewEvidence)
	}{
		{"forged quote signature", reasonQuote, func(_ *testing.T, _ *harness, e *protocol.RenewEvidence) {
			e.Quote.Signature[len(e.Quote.Signature)-1] ^= 0xff
		}},
		{"forged PCR values", reasonQuote, func(_ *testing.T, _ *harness, e *protocol.RenewEvidence) {
			e.PCRs[0].Digest = bytes.Repeat([]byte{0xaa}, 32)
		}},
		{"quote from an unknown key", reasonQuote, func(t *testing.T, h *harness, e *protocol.RenewEvidence) {
			e.Quote = foreignQuote(t, h, quoteNonce(t, e))
		}},
		{"certifies another key", reasonLDevID, func(t *testing.T, h *harness, e *protocol.RenewEvidence) {
			e.LDevID.Public = foreignPublic(t, h)
		}},
		{"forged LDevID certification", reasonLDevID, func(_ *testing.T, _ *harness, e *protocol.RenewEvidence) {
			e.LDevID.Signature[len(e.LDevID.Signature)-1] ^= 0xff
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, f := activeNode(t)
			before, rec := snapshot(t, h, f)
			h.tamperRenew = func(_ string, e *protocol.RenewEvidence) { c.tamper(t, h, e) }
			r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }())
			if r.Status != http.StatusForbidden || r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != c.reason {
				t.Fatalf("%s: %+v", c.name, r)
			}
			untouched(t, h, f, before, rec)
			if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_checks_total{machine="testbox",verdict="refused"} 1`) {
				t.Fatalf("metrics lack the refusal:\n%s", m)
			}
		})
	}
}

// A replayed quote carries another session's nonce: refused, and nothing
// recorded. A session answers one evidence only.
func TestDailyCheckRefusesAReplayedQuote(t *testing.T) {
	h, f := activeNode(t)
	var mu sync.Mutex
	var captured protocol.RenewEvidence
	var firstSession string
	h.tamperRenew = func(session string, e *protocol.RenewEvidence) {
		mu.Lock()
		defer mu.Unlock()
		captured, firstSession = *e, session
	}
	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatal(err)
	}
	h.tamperRenew = nil
	mu.Lock()
	defer mu.Unlock()
	f.settled(t, simSerial, 3)
	before, rec := snapshot(t, h, f)

	// The same evidence to its own session again: the session is spent.
	if code, body := h.post(strings.Replace(protocol.PathRenewEvidence, "{session}", firstSession, 1), captured); code != http.StatusNotFound {
		t.Fatalf("evidence replayed to its spent session: %d %s", code, body)
	}
	// The same evidence to a fresh session: the nonce is not this session's.
	var started protocol.RenewStart
	if code, body := h.post(protocol.PathRenew, protocol.RenewRequest{Serial: simSerial, Check: true}); code != http.StatusOK {
		t.Fatalf("check start: %d %s", code, body)
	} else if err := json.Unmarshal(body, &started); err != nil || !started.Check {
		t.Fatalf("check start: %s", body)
	}
	code, body := h.post(strings.Replace(protocol.PathRenewEvidence, "{session}", started.Session, 1), captured)
	var v protocol.Verdict
	_ = json.Unmarshal(body, &v)
	if code != http.StatusForbidden || v.Verdict != protocol.VerdictRefused || v.Reason != reasonQuote {
		t.Fatalf("replayed quote: %d %s", code, body)
	}
	untouched(t, h, f, before, rec)
}

// Transport failures and timeouts prove nothing about the boot: they record
// nothing and never quarantine. A NetBox that cannot be written after the
// proof leaves the pass on the anchor and fails nothing.
func TestDailyCheckTransportFailuresNeverQuarantine(t *testing.T) {
	h, f := activeNode(t)
	before, rec := snapshot(t, h, f)

	t.Run("truncated evidence", func(t *testing.T) {
		started := h.startCheck(t)
		resp, err := http.Post(h.ts.URL+strings.Replace(protocol.PathRenewEvidence, "{session}", started.Session, 1), "application/json", strings.NewReader(`{"quote":{"quote":"AAEC`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("truncated evidence: %d", resp.StatusCode)
		}
		untouched(t, h, f, before, rec)
	})
	t.Run("session timed out", func(t *testing.T) {
		started := h.startCheck(t)
		h.v.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
		defer func() { h.v.Now = time.Now }()
		if code, body := h.post(strings.Replace(protocol.PathRenewEvidence, "{session}", started.Session, 1), protocol.RenewEvidence{}); code != http.StatusNotFound {
			t.Fatalf("evidence after the session expired: %d %s", code, body)
		}
		untouched(t, h, f, before, rec)
	})
	t.Run("service unreachable", func(t *testing.T) {
		dead := httptest.NewServer(http.NotFoundHandler())
		dead.Close()
		if _, err := h.check(dead.URL, "1.0"); err == nil {
			t.Fatal("a check against a dead service passed")
		}
		untouched(t, h, f, before, rec)
	})
	t.Run("NetBox down at the start", func(t *testing.T) {
		f.setFailing(true, false)
		defer f.setFailing(false, false)
		r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }())
		if r.Status != http.StatusServiceUnavailable || r.Verdict.Verdict != protocol.VerdictRefused {
			t.Fatalf("NetBox down: %+v", r)
		}
		f.setFailing(false, false)
		untouched(t, h, f, before, rec)
	})
	t.Run("NetBox write fails after the proof", func(t *testing.T) {
		f.setFailing(false, true)
		defer f.setFailing(false, false)
		res, err := h.check(h.ts.URL, "1.0")
		if err != nil || !res.Checked {
			t.Fatalf("check with NetBox refusing writes: %+v %v", res, err)
		}
		f.setFailing(false, false)
		if d := f.bySerial(simSerial); d.Status != "active" || d.Patches != before.Patches {
			t.Fatalf("NetBox after a failed write: %s, %d writes", d.Status, d.Patches)
		}
		if now, _, _ := h.v.Store.Record("testbox"); now.Status != StatusAttested || !now.CheckedAt.After(rec.CheckedAt) {
			t.Fatalf("record after a pass NetBox missed: %+v", now)
		}
	})
}

// A quarantine recorded while a check was in flight stands: the check's
// pass, built on the record as it stood at the start, writes nothing.
func TestDailyCheckNeverUndoesAQuarantineMidFlight(t *testing.T) {
	h, f := activeNode(t)
	h.tamperRenew = func(_ string, _ *protocol.RenewEvidence) {
		rec, _, _ := h.v.Store.Record("testbox")
		rec.Status, rec.Reason, rec.UpdatedAt = StatusQuarantined, reasonPolicy, time.Now()
		if err := h.v.Store.Save(rec, nil); err != nil {
			t.Error(err)
		}
	}
	r := refusal(t, func() error { _, err := h.check(h.ts.URL, "1.0"); return err }())
	if r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != reasonStatus {
		t.Fatalf("a check across a quarantine: %+v", r)
	}
	time.Sleep(100 * time.Millisecond)
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusQuarantined {
		t.Fatalf("the check undid the quarantine: %+v", rec)
	}
	if d := f.bySerial(simSerial); d.Patches != 2 {
		t.Fatalf("the check wrote NetBox %d times", d.Patches)
	}
}

// A client against a service that predates the check sends no evidence,
// which that service would answer with new certificates.
func TestDailyCheckAgainstAnOlderService(t *testing.T) {
	h, f := activeNode(t)
	var evidence atomic.Int32
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/evidence") {
			evidence.Add(1)
		}
		if r.URL.Path == protocol.PathRenew {
			// An older service reads the serial alone and opens a renewal.
			var req protocol.RenewRequest
			_ = json.NewDecoder(r.Body).Decode(&req)
			b, _ := json.Marshal(protocol.RenewRequest{Serial: req.Serial})
			r.Body = io.NopCloser(bytes.NewReader(b))
			r.ContentLength = int64(len(b))
		}
		h.srv.Public().ServeHTTP(w, r)
	}))
	defer old.Close()
	first := nvLDevID(t, h)
	if _, err := h.check(old.URL, "1.0"); !errors.Is(err, client.ErrCheckUnsupported) {
		t.Fatalf("check against an older service: %v", err)
	}
	if evidence.Load() != 0 {
		t.Fatal("the client sent evidence to a service that would renew")
	}
	if after := nvLDevID(t, h); after.SerialNumber.Cmp(first.SerialNumber) != 0 {
		t.Fatal("NV changed")
	}
	if d := f.bySerial(simSerial); d.Patches != 2 {
		t.Fatalf("NetBox written %d times", d.Patches)
	}
}

// PCR 0 is recorded per BIOS version. A change at the same version alerts
// and never quarantines; a new version records a new entry; the owner
// explains a change by editing the entry, which clears the alert.
func TestDailyCheckRecordsPCR0PerBIOSVersion(t *testing.T) {
	h, f := activeNode(t)
	pcr0 := simPCR0(t, h)

	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatal(err)
	}
	d := f.settled(t, simSerial, 3)
	if got, _ := d.CustomFields["pcr0_by_bios"].(map[string]any); got["1.0"] != pcr0 {
		t.Fatalf("pcr0_by_bios after the first check: %+v", d.CustomFields["pcr0_by_bios"])
	}

	stale := strings.Repeat("0", 64)
	f.set(simSerial, func(d *fakeDevice) { d.CustomFields["pcr0_by_bios"] = map[string]any{"1.0": stale} })
	res, err := h.check(h.ts.URL, "1.0")
	if err != nil || !res.Checked {
		t.Fatalf("a PCR 0 change refused the check: %v", err)
	}
	d = f.settled(t, simSerial, 4)
	if d.Status != "active" || d.CustomFields["attest_verdict"] != StatusAttested {
		t.Fatalf("a PCR 0 change quarantined: %s %+v", d.Status, d.CustomFields)
	}
	if got, _ := d.CustomFields["pcr0_by_bios"].(map[string]any); got["1.0"] != stale {
		t.Fatalf("the unexplained PCR 0 was written over the record: %+v", got)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_pcr0_changed{machine="testbox"} 1`) {
		t.Fatalf("metrics lack the PCR 0 change:\n%s", m)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.pcr0"`) {
		t.Fatalf("no audit line for the PCR 0 change:\n%s", h.audit.String())
	}
	waitFor(t, "the PCR 0 journal entry", func() bool { return f.journaled("warning: fleetd: PCR 0 at BIOS 1.0 is " + pcr0) })

	// A BIOS update explains a new PCR 0: a new entry, and no alert.
	if _, err := h.check(h.ts.URL, "R21 Ver. 02.15.00"); err != nil {
		t.Fatal(err)
	}
	d = f.settled(t, simSerial, 5)
	if got, _ := d.CustomFields["pcr0_by_bios"].(map[string]any); got["R21 Ver. 02.15.00"] != pcr0 || got["1.0"] != stale || d.CustomFields["bios_version"] != "R21 Ver. 02.15.00" {
		t.Fatalf("after a BIOS update: %+v", d.CustomFields)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_pcr0_changed{machine="testbox"} 0`) {
		t.Fatalf("a BIOS update raised the PCR 0 alert:\n%s", m)
	}

	// The owner explains the change at 1.0; the next check there clears it.
	// Entries the owner wrote in another form go back as they were.
	f.set(simSerial, func(d *fakeDevice) {
		d.CustomFields["pcr0_by_bios"] = map[string]any{"1.0": strings.ToUpper(pcr0), "0.9": map[string]any{"note": "pre-lab"}}
	})
	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatal(err)
	}
	f.settled(t, simSerial, 6)
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_pcr0_changed{machine="testbox"} 0`) {
		t.Fatalf("the explained change still alerts:\n%s", m)
	}
	if _, err := h.check(h.ts.URL, "1.1"); err != nil {
		t.Fatal(err)
	}
	d = f.settled(t, simSerial, 7)
	if got, _ := d.CustomFields["pcr0_by_bios"].(map[string]any); got["1.0"] != strings.ToUpper(pcr0) || got["1.1"] != pcr0 || got["0.9"].(map[string]any)["note"] != "pre-lab" {
		t.Fatalf("the owner's entries after a new version: %+v", got)
	}

	// Without the field in NetBox, the check still passes and writes no PCR 0.
	f.set(simSerial, func(d *fakeDevice) { delete(d.CustomFields, "pcr0_by_bios") })
	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatal(err)
	}
	if d := f.settled(t, simSerial, 8); d.CustomFields["pcr0_by_bios"] != nil {
		t.Fatalf("a PCR 0 written to a field NetBox lacks: %+v", d.CustomFields)
	}
}

// A renewal is a passing quote from the running node too: it counts as the
// day's check and records PCR 0.
func TestRenewalCountsAsTheDaysCheck(t *testing.T) {
	h, f := activeNode(t)
	roots := x509.NewCertPool()
	roots.AddCert(h.v.CA.Cert)
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := client.Renew(context.Background(), h.sim, client.RenewConfig{BaseURL: h.ts.URL, Serial: simSerial, EventLog: h.eventLog, Roots: roots, Now: h.v.Now, RenewBefore: 10 * 365 * 24 * time.Hour, Check: true, BIOS: "1.0"}); err != nil {
		t.Fatal(err)
	}
	rec, _, _ := h.v.Store.Record("testbox")
	if !rec.Renewed || rec.CheckedAt.IsZero() {
		t.Fatalf("record after the renewal %+v", rec)
	}
	if d := f.settled(t, simSerial, 3); d.CustomFields["pcr0_by_bios"].(map[string]any)["1.0"] != simPCR0(t, h) {
		t.Fatalf("the renewal recorded no PCR 0: %+v", d.CustomFields)
	}
}

func (h *harness) post(path string, body any) (int, []byte) {
	h.t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(h.ts.URL+path, "application/json", bytes.NewReader(b))
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out bytes.Buffer
	_, _ = out.ReadFrom(resp.Body)
	return resp.StatusCode, out.Bytes()
}

func (h *harness) startCheck(t *testing.T) protocol.RenewStart {
	t.Helper()
	code, body := h.post(protocol.PathRenew, protocol.RenewRequest{Serial: simSerial, Check: true})
	var s protocol.RenewStart
	if err := json.Unmarshal(body, &s); err != nil || code != http.StatusOK || !s.Check {
		t.Fatalf("check start: %d %s", code, body)
	}
	return s
}

// quoteNonce is the qualifying data a quote carries: its session's nonce.
func quoteNonce(t *testing.T, e *protocol.RenewEvidence) []byte {
	t.Helper()
	att, err := tpm2.DecodeAttestationData(e.Quote.Quote)
	if err != nil {
		t.Fatal(err)
	}
	return att.ExtraData
}

// foreignQuote is a quote over the same PCRs and nonce, signed by an
// attestation key that is not the LAK on file.
func foreignQuote(t *testing.T, h *harness, nonce []byte) protocol.Quote {
	t.Helper()
	ak, _, err := tpm2.CreatePrimary(h.sim, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", client.AKTemplate)
	if err != nil {
		t.Fatal(err)
	}
	defer tpm2.FlushContext(h.sim, ak)
	q, sig, err := tpm2.Quote(h.sim, ak, "", "", nonce, tpm2.PCRSelection{Hash: tpm2.AlgSHA256, PCRs: []int{0, 1, 2, 3, 4, 5, 6, 7}}, tpm2.AlgNull)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := sig.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return protocol.Quote{Quote: q, Signature: raw}
}

// foreignPublic is another TPM key's public area.
func foreignPublic(t *testing.T, h *harness) []byte {
	t.Helper()
	k, pub, err := tpm2.CreatePrimary(h.sim, tpm2.HandleOwner, tpm2.PCRSelection{}, "", "", client.AKTemplate)
	if err != nil {
		t.Fatal(err)
	}
	defer tpm2.FlushContext(h.sim, k)
	_ = pub
	p, _, _, err := tpm2.ReadPublic(h.sim, k)
	if err != nil {
		t.Fatal(err)
	}
	b, err := p.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// journaled is whether a journal entry contains s.
func (f *fakeNetBox) journaled(s string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, j := range f.journal {
		if strings.Contains(j, s) {
			return true
		}
	}
	return false
}
