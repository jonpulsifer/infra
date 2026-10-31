//go:build cgo

// Intake on the software TPM: the approved binding git declares for a
// planned device is the authorization, and anything else waits or is refused.
package attest

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"maps"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// macOf is the primary MAC on the device's interfaces.
func (f *fakeNetBox) macOf(serial string) string {
	id := f.bySerial(serial).ID
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, i := range f.interfaces {
		if i.DeviceID == id && i.MAC != "" {
			return i.MAC
		}
	}
	return ""
}

func (h *harness) pending(t *testing.T, serial string) {
	t.Helper()
	r := refusal(t, func() error { _, err := h.run(serial, simMAC); return err }())
	if r.Verdict.Verdict != protocol.VerdictPending {
		t.Fatalf("%s: %+v, want pending", serial, r.Verdict)
	}
	if _, ok, _ := h.v.Store.Pending(serial); !ok {
		t.Fatalf("%s: no pending claim", serial)
	}
}

func (h *harness) intakeAudited(serial string) bool {
	for _, line := range strings.Split(h.audit.String(), "\n") {
		if strings.Contains(line, `"event":"attest.intake"`) && strings.Contains(line, `"serial":"`+serial+`"`) && strings.Contains(line, `"status":"pass"`) {
			return true
		}
	}
	return false
}

// issued is whether the service signed an LDevID for anyone.
func (h *harness) issued() bool {
	return strings.Contains(h.audit.String(), `"event":"attest.issue"`)
}

// bound adds the harness TPM's EKs to fields as the approved binding the
// nodes file declares and Terraform projects into NetBox.
func (h *harness) bound(fields map[string]any) map[string]any {
	out := map[string]any{"approved_ek_hash": h.hashes["rsa"], "approved_ek_hash_ecc": h.hashes["ecc"]}
	maps.Copy(out, fields)
	return out
}

// bind gives the harness's seeded device the harness TPM's binding.
func (h *harness) bind() {
	h.nb.set(simSerial, func(d *fakeDevice) { maps.Copy(d.CustomFields, h.bound(nil)) })
}

// certifiedStart posts a Start for serial from another genuine TPM: fresh
// RSA and ECC EKs with certificates from the harness TPM's maker.
func certifiedStart(t *testing.T, h *harness, serial string) (int, string) {
	t.Helper()
	r, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	e, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var eks []protocol.EK
	for _, pub := range []crypto.PublicKey{&r.PublicKey, &e.PublicKey} {
		der, _ := x509.MarshalPKIXPublicKey(pub)
		eks = append(eks, protocol.EK{Public: der, Cert: h.mfr.issueEK(t, pub)})
	}
	claim := simClaim
	claim.Serial = serial
	b, _ := json.Marshal(protocol.StartRequest{Machine: claim, EKs: eks})
	resp, err := http.Post(h.ts.URL+protocol.PathStart, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	return resp.StatusCode, buf.String()
}

// The box that attests as a bound stub's serial passes and binds to it; the
// stub stays planned until its node fetches its config. A serial with no
// stub stays pending.
func TestDeclaredStubBinds(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})

	f.add("swell", "SIM-STUB", statusPlanned, "", h.bound(map[string]any{"talos_class": "worker-g5"}))
	if res, err := h.run("SIM-STUB", simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("declared stub: %v", err)
	}
	d := f.settled(t, "SIM-STUB", 2)
	if d.Name != "swell" || d.Status != statusPlanned || d.CustomFields["ek_hash"] != h.hashes["rsa"] || f.count() != 1 {
		t.Fatalf("stub after its pass: %s %s %+v (%d devices)", d.Name, d.Status, d.CustomFields, f.count())
	}
	if d.CustomFields["approved_ek_hash"] != h.hashes["rsa"] || d.CustomFields["approved_ek_hash_ecc"] != h.hashes["ecc"] {
		t.Fatalf("the pass wrote the approved binding: %+v", d.CustomFields)
	}
	if mac := f.macOf("SIM-STUB"); mac != simMAC {
		t.Fatalf("stub MAC %q", mac)
	}
	if !h.intakeAudited("SIM-STUB") || !strings.Contains(h.audit.String(), "bound to the declared stub; MAC written") {
		t.Fatalf("no attest.intake line for the binding:\n%s", h.audit.String())
	}

	h.pending(t, simSerial)
	if f.count() != 1 || h.intakeAudited(simSerial) {
		t.Fatal("a serial with no stub was admitted")
	}
}

// A planned stub without an approved binding waits, though its maker
// certified every EK, and so does one whose EK has no certificate. Neither
// binds, issues or pins anything.
func TestUnboundStubWaits(t *testing.T) {
	for _, c := range []struct {
		name string
		opts harnessOpts
	}{
		{"certified EKs", harnessOpts{inventory: emptyInventory}},
		{"uncertified EK", harnessOpts{inventory: emptyInventory, noEKCerts: true}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			c.opts.netbox = f
			h := newHarness(t, c.opts)
			f.add("swell", "SIM-STUB", statusPlanned, "", map[string]any{"talos_class": "worker-g5"})
			h.pending(t, "SIM-STUB")
			d := f.bySerial("SIM-STUB")
			if h.intakeAudited("SIM-STUB") || h.issued() || f.macOf("SIM-STUB") != "" || d.CustomFields["ek_hash"] != nil || d.CustomFields["attest_verdict"] != StatusPending {
				t.Fatalf("an unbound stub was admitted: %+v", d.CustomFields)
			}
			if _, ok, _ := h.v.Store.Record("swell"); ok {
				t.Fatal("an unbound stub has a record")
			}
		})
	}
}

// An EK without a certificate passes when the binding approves exactly it;
// activation and the boot evidence are still required.
func TestBindingAdmitsAnUncertifiedEK(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f, noEKCerts: true})
	f.add("swell", "SIM-STUB", statusPlanned, "", map[string]any{"approved_ek_hash": h.hashes["rsa"]})
	h.tamper = func(r *protocol.EvidenceRequest) { r.Activated[0].Secret = make([]byte, 32) }
	if r := refusal(t, func() error { _, err := h.run("SIM-STUB", simMAC); return err }()); r.Verdict.Reason != reasonActivation {
		t.Fatalf("unactivated: %+v", r.Verdict)
	}
	h.tamper = nil
	if _, err := h.run("SIM-STUB", simMAC); err != nil {
		t.Fatalf("approved uncertified EK: %v", err)
	}
}

// A stub with a MAC on file binds only the box with that MAC.
func TestDeclaredStubWithAMAC(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("other", "SIM-OTHER", statusPlanned, "aa:bb:cc:dd:ee:ff", h.bound(nil))
	if r := refusal(t, func() error { _, err := h.run("SIM-OTHER", simMAC); return err }()); r.Verdict.Reason != reasonMACMismatch || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("stub with another MAC: %+v", r.Verdict)
	}
	if d := f.bySerial("SIM-OTHER"); d.Patches != 0 || f.macOf("SIM-OTHER") != "aa:bb:cc:dd:ee:ff" {
		t.Fatalf("a refused stub changed: %+v", d)
	}
	f.add("swell", "SIM-STUB", statusPlanned, simMAC, h.bound(nil))
	if _, err := h.run("SIM-STUB", simMAC); err != nil {
		t.Fatalf("stub with this MAC: %v", err)
	}
	if !strings.Contains(h.audit.String(), "bound to the declared stub; MAC already on file") {
		t.Fatalf("no attest.intake line for the binding:\n%s", h.audit.String())
	}
	if r := refusal(t, func() error { _, err := h.run("SIM-STUB", "not-a-mac"); return err }()); r.Verdict.Reason != reasonMACMismatch {
		t.Fatalf("a claim that is no MAC: %+v", r.Verdict)
	}
}

// The device is looked up again right before anything is issued: a stub
// another box bound, whose approval was replaced or removed, or that left
// planned meanwhile refuses this one, and nothing is written or issued.
func TestDeclaredStubIsRecheckedBeforeIssue(t *testing.T) {
	for _, c := range []struct {
		name, reason string
		change       func(*fakeNetBox, *fakeDevice)
	}{
		{"bound to another MAC", reasonMACMismatch, func(f *fakeNetBox, d *fakeDevice) {
			for _, i := range f.interfaces {
				if i.DeviceID == d.ID {
					f.next++
					i.MAC, i.MACID = "aa:bb:cc:dd:ee:ff", f.next
				}
			}
		}},
		{"approval replaced", reasonBinding, func(_ *fakeNetBox, d *fakeDevice) { d.CustomFields["approved_ek_hash"] = strings.Repeat("ab", 32) }},
		{"approval removed", reasonBinding, func(_ *fakeNetBox, d *fakeDevice) {
			delete(d.CustomFields, "approved_ek_hash")
			delete(d.CustomFields, "approved_ek_hash_ecc")
		}},
		{"one approval removed", reasonBinding, func(_ *fakeNetBox, d *fakeDevice) { d.CustomFields["approved_ek_hash_ecc"] = nil }},
		{"no longer planned", reasonStatus, func(_ *fakeNetBox, d *fakeDevice) { d.Status = "active" }},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			d := f.add("swell", "SIM-STUB", statusPlanned, "", h.bound(nil))
			h.v.Installer = newFakeInstaller(nil)
			h.tamper = func(*protocol.EvidenceRequest) {
				f.mu.Lock()
				defer f.mu.Unlock()
				c.change(f, d)
			}
			r := refusal(t, func() error { _, err := h.run("SIM-STUB", simMAC); return err }())
			if r.Verdict.Reason != c.reason || r.Verdict.Verdict != protocol.VerdictRefused {
				t.Fatalf("%+v", r.Verdict)
			}
			after := f.bySerial("SIM-STUB")
			if after.Patches != 0 || after.CustomFields["ek_hash"] == h.hashes["rsa"] || h.intakeAudited("SIM-STUB") || h.issued() {
				t.Fatalf("a refused binding wrote or issued: %+v", after)
			}
			if _, ok, _ := h.v.Store.Record("swell"); ok {
				t.Fatal("a refused binding wrote a record")
			}
		})
	}
}

// Another genuine TPM, certified by a trusted maker, that claims a bound
// planned serial gets no identity and no config. The refusal is journaled
// on the device, at most every ten minutes, and touches neither the binding
// nor the device, which stays free for its own TPM.
func TestAnotherCertifiedTPMGetsNothing(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	approved := map[string]any{"approved_ek_hash": strings.Repeat("ab", 32), "approved_ek_hash_ecc": strings.Repeat("cd", 32), "talos_class": "worker-g5"}
	f.add("swell", "SIM-STUB", statusPlanned, "", approved)
	installer := newFakeInstaller(nil)
	h.v.Installer = installer
	for range 2 {
		r := refusal(t, func() error { _, err := h.run("SIM-STUB", simMAC); return err }())
		if r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != reasonEKHash {
			t.Fatalf("another TPM: %+v", r.Verdict)
		}
	}
	d := f.bySerial("SIM-STUB")
	if d.Patches != 0 || d.Status != statusPlanned || d.CustomFields["ek_hash"] != nil || f.macOf("SIM-STUB") != "" ||
		d.CustomFields["approved_ek_hash"] != approved["approved_ek_hash"] || d.CustomFields["approved_ek_hash_ecc"] != approved["approved_ek_hash_ecc"] {
		t.Fatalf("the refused TPM changed the device: %+v", d.CustomFields)
	}
	if h.issued() || len(installer.requests()) != 0 {
		t.Fatal("the refused TPM got an identity or a config")
	}
	if _, ok, _ := h.v.Store.Record("swell"); ok {
		t.Fatal("the refused TPM wrote a record")
	}
	if _, ok, _ := h.v.Store.Pending("SIM-STUB"); ok {
		t.Fatal("a mismatch waits as a claim")
	}
	waitFor(t, "the mismatch journal entry", func() bool { return f.journaled("not its approved binding") })
	f.mu.Lock()
	n := len(f.journal)
	f.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d journal entries for two refusals within ten minutes", n)
	}
}

// The approved TPM gets nothing until it activates its credentials and its
// quote and boot meet the policy.
func TestApprovedTPMStillProvesItsBoot(t *testing.T) {
	for _, c := range []struct {
		name, reason string
		tamper       func(t *testing.T, r *protocol.EvidenceRequest)
	}{
		{"credential not activated", reasonActivation, func(_ *testing.T, r *protocol.EvidenceRequest) { r.Activated[1].Secret = make([]byte, 32) }},
		{"quote forged", reasonQuote, func(_ *testing.T, r *protocol.EvidenceRequest) { r.Quote.Signature[len(r.Quote.Signature)-1] ^= 0xff }},
		{"boot breaks the policy", reasonEventLog, func(t *testing.T, r *protocol.EvidenceRequest) {
			r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin")
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			f.add("swell", "SIM-STUB", statusPlanned, "", h.bound(map[string]any{"talos_class": "worker-g5"}))
			installer := newFakeInstaller(nil)
			h.v.Installer = installer
			h.tamper = func(r *protocol.EvidenceRequest) { c.tamper(t, r) }
			if r := refusal(t, func() error { _, err := h.run("SIM-STUB", simMAC); return err }()); r.Verdict.Reason != c.reason {
				t.Fatalf("%+v", r.Verdict)
			}
			if h.issued() || len(installer.requests()) != 0 || f.macOf("SIM-STUB") != "" {
				t.Fatal("the approved TPM got an identity before it proved its boot")
			}
		})
	}
}

// Claims from other TPMs racing the approved one never change the binding:
// each is refused, and the approved TPM passes with its own EKs on file.
func TestConcurrentClaimsCannotChangeTheBinding(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("swell", "SIM-STUB", statusPlanned, "", h.bound(nil))
	var wg sync.WaitGroup
	bodies := make([]string, 8)
	for i := range bodies {
		wg.Go(func() {
			code, body := certifiedStart(t, h, "SIM-STUB")
			if code != http.StatusForbidden {
				body = "unexpected status: " + body
			}
			bodies[i] = body
		})
	}
	res, err := h.run("SIM-STUB", simMAC)
	wg.Wait()
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("the approved TPM: %v", err)
	}
	for i, b := range bodies {
		if !strings.Contains(b, `"verdict":"refused"`) || !strings.Contains(b, reasonEKHash) {
			t.Fatalf("claim %d: %s", i, b)
		}
	}
	d := f.settled(t, "SIM-STUB", 2)
	if d.CustomFields["approved_ek_hash"] != h.hashes["rsa"] || d.CustomFields["approved_ek_hash_ecc"] != h.hashes["ecc"] ||
		d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != h.hashes["ecc"] {
		t.Fatalf("the binding or the pins after the race: %+v", d.CustomFields)
	}
	if rec, _, _ := h.v.Store.Record("swell"); rec.EKHashes["rsa"] != h.hashes["rsa"] {
		t.Fatalf("record after the race: %+v", rec)
	}
}

// A replaced TPM passes once the owner changes the binding, and its pass
// replaces the old TPM's pins on file.
func TestABindingChangeReplacesTheTPM(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("swell", "SIM-STUB", statusPlanned, simMAC, map[string]any{"ek_hash": strings.Repeat("ab", 32), "ek_hash_ecc": strings.Repeat("cd", 32)})
	h.pending(t, "SIM-STUB")
	f.set("SIM-STUB", func(d *fakeDevice) { maps.Copy(d.CustomFields, h.bound(nil)) })
	if _, err := h.run("SIM-STUB", simMAC); err != nil {
		t.Fatalf("after the binding changed: %v", err)
	}
	if d := f.settled(t, "SIM-STUB", 3); d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != h.hashes["ecc"] {
		t.Fatalf("pins after the replacement: %+v", d.CustomFields)
	}
}

// Once a node runs, neither a reboot into HookOS nor a renewal nor the
// daily check needs its binding: an unbound active node keeps working on
// the pins its passes proved.
func TestRebootAndRenewalNeedNoNewApproval(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, statusPlanned, simMAC, h.bound(map[string]any{"talos_class": "worker-g5"}))
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	f.settled(t, simSerial, 2)
	f.set(simSerial, func(d *fakeDevice) {
		d.Status = "active"
		delete(d.CustomFields, "approved_ek_hash")
		delete(d.CustomFields, "approved_ek_hash_ecc")
	})
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("renewal: %v", err)
	}
	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatalf("daily check: %v", err)
	}
	if res, err := h.run(simSerial, simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("reboot into HookOS: %v", err)
	}
	if pendings, _ := h.v.Store.Pendings(); len(pendings) != 0 {
		t.Fatalf("a running node waits for approval: %+v", pendings)
	}
}

// A binding the owner adds to a running node while it attests from HookOS
// on its pins invalidates that session: the pass issues nothing until the
// node attests again against the binding.
func TestABindingAddedDuringTheSessionRefuses(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "active", simMAC, map[string]any{"talos_class": "worker-g5", "ek_hash": h.hashes["rsa"], "ek_hash_ecc": h.hashes["ecc"]})
	h.tamper = func(*protocol.EvidenceRequest) {
		f.set(simSerial, func(d *fakeDevice) { d.CustomFields["approved_ek_hash"] = strings.Repeat("ab", 32) })
	}
	r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }())
	if r.Verdict.Reason != reasonBinding || r.Verdict.Verdict != protocol.VerdictRefused || h.issued() {
		t.Fatalf("a session the binding changed under: %+v", r.Verdict)
	}
	h.tamper = nil
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Reason != reasonEKHash {
		t.Fatalf("against the new binding: %+v", r.Verdict)
	}
}

// A pass against a binding pins the binding alone. A replaced TPM under an
// RSA-only binding clears the old TPM's ECC pin, which SPIRE would otherwise
// still take, and the new TPM's extra ECC EK, certified and activated, is
// never pinned.
func TestABoundPassPinsTheBindingAlone(t *testing.T) {
	for _, c := range []struct {
		name string
		pins map[string]any
	}{
		{"replaced TPM", map[string]any{"ek_hash": strings.Repeat("ab", 32), "ek_hash_ecc": strings.Repeat("cd", 32)}},
		{"extra ECC EK", nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			fields := map[string]any{"approved_ek_hash": h.hashes["rsa"], "talos_class": "worker-g5"}
			maps.Copy(fields, c.pins)
			f.add("swell", "SIM-STUB", statusPlanned, simMAC, fields)
			if _, err := h.run("SIM-STUB", simMAC); err != nil {
				t.Fatalf("the approved TPM: %v", err)
			}
			d := f.settled(t, "SIM-STUB", 2)
			if d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != nil {
				t.Fatalf("pins after a pass against an RSA-only binding: %+v", d.CustomFields)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			for _, ch := range f.changes {
				if ch.Post["ek_hash_ecc"] == h.hashes["ecc"] {
					t.Fatalf("the extra ECC EK was pinned in change %d", ch.ID)
				}
			}
		})
	}
}

// A planned device gets its identity only from an intake pass: a renewal
// is refused and journaled, and quarantines nothing. The daily check, which
// issues nothing, still runs, and an active node renews with no binding.
func TestRenewalRefusedWhilePlanned(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, statusPlanned, simMAC, h.bound(map[string]any{"talos_class": "worker-g5"}))
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	f.settled(t, simSerial, 2)
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if r := refusal(t, func() error { _, err := h.renew(simSerial); return err }()); r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != reasonStatus {
		t.Fatalf("renewal while planned: %+v", r.Verdict)
	}
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusAttested {
		t.Fatalf("a refused renewal changed the record: %+v", rec)
	}
	waitFor(t, "the renewal journal entry", func() bool { return f.journaled("refused a renewal while the device is planned") })
	if _, err := h.check(h.ts.URL, "1.0"); err != nil {
		t.Fatalf("daily check while planned: %v", err)
	}
	f.set(simSerial, func(d *fakeDevice) {
		d.Status = "active"
		delete(d.CustomFields, "approved_ek_hash")
		delete(d.CustomFields, "approved_ek_hash_ecc")
	})
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("an active node's renewal: %v", err)
	}
}

// A binding that changes while Evidence runs either refuses the pass, or
// the pass issues and pins against the binding that held at its re-check,
// never a mix of the two. A change that lands between the re-check's device
// read and its changelog read refuses as unauthored: the newest change no
// longer sets the value the device read showed.
func TestEvidenceRacingABindingChange(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	other := strings.Repeat("ab", 32)
	for i := range 6 {
		serial := "SIM-RACE-" + string(rune('A'+i))
		f.add("race"+strings.ToLower(serial[len(serial)-1:]), serial, statusPlanned, "", h.bound(nil))
		var wg sync.WaitGroup
		h.tamper = func(*protocol.EvidenceRequest) {
			wg.Go(func() {
				time.Sleep(time.Duration(i) * 2 * time.Millisecond)
				f.set(serial, func(d *fakeDevice) { d.CustomFields["approved_ek_hash"] = other })
			})
		}
		res, err := h.run(serial, simMAC)
		wg.Wait()
		if err != nil {
			if r := refusal(t, err); r.Verdict.Reason != reasonBinding && r.Verdict.Reason != reasonBindingAuthor {
				t.Fatalf("%s: %+v", serial, r.Verdict)
			}
			continue
		}
		if res.Verdict.Verdict != protocol.VerdictPass {
			t.Fatalf("%s: %+v", serial, res.Verdict)
		}
		d := f.settled(t, serial, 2)
		if d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != h.hashes["ecc"] {
			t.Fatalf("%s: pins after a raced pass: %+v", serial, d.CustomFields)
		}
	}
}

// A binding whose newest change another NetBox user made is refused at the
// start and again right before issue, and nothing is recorded.
func TestABindingNotFromTerraformRefuses(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("swell", "SIM-STUB", statusPlanned, "", map[string]any{"talos_class": "worker-g5"})
	f.author = "owner"
	f.set("SIM-STUB", func(d *fakeDevice) { maps.Copy(d.CustomFields, h.bound(nil)) })
	if r := refusal(t, func() error { _, err := h.run("SIM-STUB", simMAC); return err }()); r.Verdict.Reason != reasonBindingAuthor || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("a binding the owner wrote: %+v", r.Verdict)
	}
	waitFor(t, "the journal entry", func() bool { return f.journaled("binding last changed by owner, not Terraform") })

	// Terraform writes it again, and another user rewrites it mid-session
	// to the same value: the re-check before issue refuses.
	f.author = fakeTerraform
	f.set("SIM-STUB", func(d *fakeDevice) { delete(d.CustomFields, "approved_ek_hash") })
	f.set("SIM-STUB", func(d *fakeDevice) { maps.Copy(d.CustomFields, h.bound(nil)) })
	h.tamper = func(*protocol.EvidenceRequest) {
		f.author = "owner"
		f.set("SIM-STUB", func(d *fakeDevice) { delete(d.CustomFields, "approved_ek_hash") })
		f.set("SIM-STUB", func(d *fakeDevice) { d.CustomFields["approved_ek_hash"] = h.hashes["rsa"] })
	}
	if r := refusal(t, func() error { _, err := h.run("SIM-STUB", simMAC); return err }()); r.Verdict.Reason != reasonBindingAuthor {
		t.Fatalf("a binding rewritten mid-session: %+v", r.Verdict)
	}
	if d := f.bySerial("SIM-STUB"); d.Patches != 0 || h.issued() {
		t.Fatalf("a refused binding wrote or issued: %+v", d.CustomFields)
	}
}
