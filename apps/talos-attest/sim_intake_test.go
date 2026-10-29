//go:build cgo

// The owner's open intake window on the software TPM: an unknown serial
// with a pinned maker's EK certificates passes as a planned machine does,
// and nothing changes for a serial NetBox knows.
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// window gives the harness an intake window file under policy, open until
// until, or with no file when until is zero.
func (h *harness) window(t *testing.T, policy string, until time.Time) {
	t.Helper()
	h.v.Intake = &IntakeWindow{Path: filepath.Join(t.TempDir(), "intake-open"), Policy: policy}
	if !until.IsZero() {
		h.writeWindow(t, until)
	}
}

// writeWindow writes the file as scripts/fleet-intake.sh does over ssh.
func (h *harness) writeWindow(t *testing.T, until time.Time) {
	t.Helper()
	if err := os.WriteFile(h.v.Intake.Path, []byte(until.UTC().Format(time.RFC3339)+"\n"), 0o640); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) admin(t *testing.T, method, path, body string) (int, IntakeState) {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Tailscale-User-Login", "owner@example.com")
	h.srv.Admin().ServeHTTP(rr, req)
	var st IntakeState
	_ = json.Unmarshal(rr.Body.Bytes(), &st)
	return rr.Code, st
}

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

func TestOpenWindowAdmitsAnUnknownSerial(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyOpen, time.Now().Add(time.Hour))

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("unknown serial in the window: %v", err)
	}
	// The claimed hostname is testbox, but the controller binds by intake-<serial>.
	d := f.settled(t, simSerial, 2)
	if d.Name != "intake-sim-0001" || d.Status != statusStaged || d.CustomFields["ek_hash"] != h.hashes["rsa"] || d.CustomFields["ek_hash_ecc"] != h.hashes["ecc"] ||
		d.CustomFields["sku"] != "TB-1" || d.CustomFields["attest_verdict"] != StatusAttested || f.count() != 1 {
		t.Fatalf("device after the window pass: %s %s %+v (%d devices)", d.Name, d.Status, d.CustomFields, f.count())
	}
	if mac := f.macOf(simSerial); mac != simMAC {
		t.Fatalf("device MAC %q", mac)
	}
	if a, _ := h.v.Store.Approvals(); len(a[simSerial]) != 2 {
		t.Fatalf("the pass did not pin the EKs: %v", a)
	}
	if !h.intakeAudited(simSerial) {
		t.Fatalf("no attest.intake line:\n%s", h.audit.String())
	}
	// The device is NetBox's now: its pins decide the next attest.
	if res, err := h.run(simSerial, simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("second attest: %v", err)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_intake_open{policy="open"} 1`) || !strings.Contains(m, `talos_attest_intake_open_until_seconds{policy="open"} `) {
		t.Fatalf("metrics:\n%s", m)
	}
}

func TestClosedWindowLeavesAnUnknownSerialPending(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyOpen, time.Now().Add(-time.Minute))
	h.pending(t, simSerial)
	if f.count() != 0 {
		t.Fatal("a closed window created a device")
	}
	if code, st := h.admin(t, http.MethodGet, "/intake", ""); code != http.StatusOK || st.Open || st.OpenUntil == nil || st.Policy != intakePolicyOpen {
		t.Fatalf("GET /intake: %d %+v", code, st)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_intake_open{policy="open"} 0`) {
		t.Fatalf("metrics:\n%s", m)
	}
}

// Only the supply chain vouches inside the window: an EK without a
// pinned maker's certificate waits for the owner as before.
func TestOpenWindowKeepsAnUncertifiedEKPending(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f, noEKCerts: true})
	h.window(t, intakePolicyOpen, time.Now().Add(time.Hour))
	h.pending(t, simSerial)
	if f.count() != 0 || h.intakeAudited(simSerial) {
		t.Fatal("an uncertified EK got a device in the window")
	}
}

func TestOpenWindowChangesNothingForAKnownSerial(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyOpen, time.Now().Add(time.Hour))

	f.add("pinned", "SIM-PINNED", statusStaged, simMAC, map[string]any{"ek_hash": strings.Repeat("ab", 32)})
	if r := refusal(t, func() error { _, err := h.run("SIM-PINNED", simMAC); return err }()); r.Verdict.Reason != reasonEKHash || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("known serial, other pins: %+v", r.Verdict)
	}
	f.add("failedbox", "SIM-FAILED", statusFailed, simMAC, nil)
	if r := refusal(t, func() error { _, err := h.run("SIM-FAILED", simMAC); return err }()); r.Verdict.Reason != reasonStatus {
		t.Fatalf("known failed serial: %+v", r.Verdict)
	}
	f.add("stagedbox", "SIM-STAGED", statusStaged, simMAC, nil)
	h.pending(t, "SIM-STAGED")
	f.add("planbox", "SIM-PLAN", statusPlanned, simMAC, map[string]any{"talos_class": "worker-g5"})
	if _, err := h.run("SIM-PLAN", simMAC); err != nil {
		t.Fatalf("known planned serial: %v", err)
	}
	if d := f.settled(t, "SIM-PLAN", 2); d.Name != "planbox" || d.Status != statusStaged {
		t.Fatalf("planned device after its pass: %s %s", d.Name, d.Status)
	}
	if f.count() != 4 {
		t.Fatalf("the window created a device for a known serial: %d devices", f.count())
	}
	for _, s := range []string{"SIM-PINNED", "SIM-FAILED", "SIM-STAGED", "SIM-PLAN"} {
		if h.intakeAudited(s) {
			t.Fatalf("%s audited as a window pass", s)
		}
	}
	if p := f.bySerial("SIM-PINNED"); p.Patches != 0 || p.Status != statusStaged {
		t.Fatalf("a refusal wrote to NetBox: %+v", p)
	}
}

// The file is read on every start: opening and closing need no restart,
// whether the owner writes it over ssh or through the admin API.
func TestWindowIsReadOnEveryStart(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyOpen, time.Time{})
	h.pending(t, simSerial)

	h.writeWindow(t, time.Now().Add(time.Hour))
	if res, err := h.run(simSerial, simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("after opening the window: %v", err)
	}
	if _, ok, _ := h.v.Store.Pending(simSerial); ok {
		t.Fatal("the claim still waits after the window pass")
	}

	if code, st := h.admin(t, http.MethodPost, "/intake", `{"open_until":""}`); code != http.StatusOK || st.Open || st.OpenUntil != nil {
		t.Fatalf("POST /intake close: %d %+v", code, st)
	}
	h.pending(t, "SIM-0002")

	until := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Second)
	code, st := h.admin(t, http.MethodPost, "/intake", `{"open_until":"`+until.Format(time.RFC3339)+`"}`)
	if code != http.StatusOK || !st.Open || st.OpenUntil == nil || !st.OpenUntil.Equal(until) {
		t.Fatalf("POST /intake open: %d %+v", code, st)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.intake","site":"folly","status":"opened","approver":"owner@example.com"`) {
		t.Fatalf("no audit line for the opening:\n%s", h.audit.String())
	}
	if res, err := h.run("SIM-0002", simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("after opening through the API: %v", err)
	}
	if code, _ := h.admin(t, http.MethodPost, "/intake", `{"open_until":"tomorrow"}`); code != http.StatusBadRequest {
		t.Fatalf("POST /intake with no RFC3339 time: %d", code)
	}
	rr := httptest.NewRecorder()
	h.srv.Admin().ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/intake", strings.NewReader(`{"open_until":""}`)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("POST /intake without an approver: %d", rr.Code)
	}
}

// Under the declared policy the planned stub the owner declared is the
// authorization, window or not: the box that attests as its serial passes
// on its EK certificates and binds to it. A serial with no stub stays
// pending even while the window is open, and the window, which gates
// nothing here, reports closed.
func TestDeclaredStubBindsWithoutAWindow(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyDeclared, time.Time{})

	f.add("swell", "SIM-STUB", statusPlanned, "", map[string]any{"talos_class": "worker-g5"})
	if res, err := h.run("SIM-STUB", simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("declared stub with the window closed: %v", err)
	}
	d := f.settled(t, "SIM-STUB", 2)
	if d.Name != "swell" || d.Status != statusStaged || d.CustomFields["ek_hash"] != h.hashes["rsa"] || f.count() != 1 {
		t.Fatalf("stub after its pass: %s %s %+v (%d devices)", d.Name, d.Status, d.CustomFields, f.count())
	}
	if mac := f.macOf("SIM-STUB"); mac != simMAC {
		t.Fatalf("stub MAC %q", mac)
	}
	if !h.intakeAudited("SIM-STUB") || !strings.Contains(h.audit.String(), "bound to the declared stub; MAC written; policy declared") {
		t.Fatalf("no attest.intake line for the binding:\n%s", h.audit.String())
	}

	h.writeWindow(t, time.Now().Add(time.Hour))
	h.pending(t, simSerial)
	if f.count() != 1 || h.intakeAudited(simSerial) {
		t.Fatal("the declared policy admitted a serial with no stub")
	}
	if code, st := h.admin(t, http.MethodGet, "/intake", ""); code != http.StatusOK || !st.Open || st.Policy != intakePolicyDeclared || st.RequireWindow {
		t.Fatalf("GET /intake: %d %+v", code, st)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_intake_open{policy="declared"} 0`) {
		t.Fatalf("metrics:\n%s", m)
	}
}

// A declared stub still needs a pinned maker's certificate on every EK.
func TestDeclaredStubKeepsAnUncertifiedEKPending(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f, noEKCerts: true})
	h.window(t, intakePolicyDeclared, time.Now().Add(time.Hour))
	f.add("swell", "SIM-STUB", statusPlanned, "", nil)
	h.pending(t, "SIM-STUB")
	if h.intakeAudited("SIM-STUB") || f.macOf("SIM-STUB") != "" {
		t.Fatal("an uncertified EK bound the stub")
	}
}

// A stub with a MAC on file binds only the box with that MAC.
func TestDeclaredStubWithAMAC(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyDeclared, time.Time{})
	f.add("other", "SIM-OTHER", statusPlanned, "aa:bb:cc:dd:ee:ff", nil)
	if r := refusal(t, func() error { _, err := h.run("SIM-OTHER", simMAC); return err }()); r.Verdict.Reason != reasonMACMismatch || r.Verdict.Verdict != protocol.VerdictRefused {
		t.Fatalf("stub with another MAC: %+v", r.Verdict)
	}
	if d := f.bySerial("SIM-OTHER"); d.Patches != 0 || f.macOf("SIM-OTHER") != "aa:bb:cc:dd:ee:ff" {
		t.Fatalf("a refused stub changed: %+v", d)
	}
	f.add("swell", "SIM-STUB", statusPlanned, simMAC, nil)
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

// The declared stub is looked up again before anything is issued: a stub
// another box bound, pinned or staged meanwhile refuses this one, and its
// pins stay.
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
		{"pinned to another EK", reasonEKHash, func(_ *fakeNetBox, d *fakeDevice) { d.CustomFields["ek_hash"] = strings.Repeat("ab", 32) }},
		{"no longer planned", reasonStatus, func(_ *fakeNetBox, d *fakeDevice) { d.Status = statusStaged }},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			h.window(t, intakePolicyDeclared, time.Time{})
			d := f.add("swell", "SIM-STUB", statusPlanned, "", nil)
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
			if after.Patches != 0 || after.CustomFields["ek_hash"] == h.hashes["rsa"] || h.intakeAudited("SIM-STUB") {
				t.Fatalf("a refused binding wrote: %+v", after)
			}
			if _, ok, _ := h.v.Store.Record("swell"); ok {
				t.Fatal("a refused binding wrote a record")
			}
		})
	}
}

// With ATTEST_INTAKE_REQUIRE_WINDOW, the data-centre setting, a declared
// stub passes only while the window is open, and the window reports open.
func TestDeclaredStubRequiresTheWindow(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyDeclared, time.Time{})
	h.v.Intake.RequireWindow = true
	f.add("swell", "SIM-STUB", statusPlanned, "", nil)
	h.pending(t, "SIM-STUB")
	if f.macOf("SIM-STUB") != "" {
		t.Fatal("a closed window bound the stub")
	}
	h.writeWindow(t, time.Now().Add(time.Hour))
	if _, err := h.run("SIM-STUB", simMAC); err != nil {
		t.Fatalf("with the window open: %v", err)
	}
	if f.macOf("SIM-STUB") != simMAC || !h.intakeAudited("SIM-STUB") {
		t.Fatal("the stub was not bound")
	}
	if code, st := h.admin(t, http.MethodGet, "/intake", ""); code != http.StatusOK || !st.Open || !st.RequireWindow {
		t.Fatalf("GET /intake: %d %+v", code, st)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_intake_open{policy="declared"} 1`) {
		t.Fatalf("metrics:\n%s", m)
	}
}

// Under open, a planned stub passes by the planned rule and is not bound.
func TestOpenPolicyDoesNotBindAStub(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyOpen, time.Now().Add(time.Hour))
	f.add("swell", "SIM-STUB", statusPlanned, "", nil)
	if _, err := h.run("SIM-STUB", simMAC); err != nil {
		t.Fatalf("planned stub under open: %v", err)
	}
	if f.macOf("SIM-STUB") != "" || h.intakeAudited("SIM-STUB") || f.count() != 1 {
		t.Fatal("the open policy bound a stub")
	}
}

// When NetBox learns the serial between the start and the evidence, the
// start's rules decide for that device, and the window pass is audited.
func TestOpenWindowRechecksADeviceNetBoxLearned(t *testing.T) {
	for _, c := range []struct {
		name, status, mac, verdict, reason string
	}{
		{"planned with another MAC", statusPlanned, "aa:bb:cc:dd:ee:ff", protocol.VerdictRefused, reasonMACMismatch},
		{"staged with no pin", statusStaged, simMAC, protocol.VerdictPending, reasonEKPending},
		{"planned with this MAC", statusPlanned, simMAC, protocol.VerdictPass, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			h.window(t, intakePolicyOpen, time.Now().Add(time.Hour))
			h.tamper = func(*protocol.EvidenceRequest) { f.add("realbox", simSerial, c.status, c.mac, nil) }
			res, err := h.run(simSerial, simMAC)
			if c.verdict == protocol.VerdictPass {
				if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
					t.Fatalf("%v", err)
				}
				if d := f.settled(t, simSerial, 2); d.Name != "realbox" || d.Status != statusStaged || f.count() != 1 {
					t.Fatalf("device after the pass: %+v (%d devices)", d, f.count())
				}
				if !h.intakeAudited(simSerial) || !strings.Contains(h.audit.String(), "NetBox learned the serial during the session") {
					t.Fatalf("no attest.intake line:\n%s", h.audit.String())
				}
				return
			}
			if r := refusal(t, err); r.Verdict.Verdict != c.verdict || r.Verdict.Reason != c.reason {
				t.Fatalf("%+v", r.Verdict)
			}
			if d := f.bySerial(simSerial); d.CustomFields["ek_hash"] != nil || d.Name != "realbox" || f.count() != 1 {
				t.Fatalf("the refusal wrote: %+v (%d devices)", d, f.count())
			}
			if h.intakeAudited(simSerial) {
				t.Fatal("a refusal was audited as a window pass")
			}
		})
	}
}

// A claim that may become a NetBox device carries a MAC that reads as one.
func TestOpenWindowRefusesAMalformedMAC(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.window(t, intakePolicyOpen, time.Now().Add(time.Hour))
	if r := refusal(t, func() error { _, err := h.run(simSerial, "zz:zz"); return err }()); r.Verdict.Reason != reasonMACInvalid {
		t.Fatalf("%+v", r.Verdict)
	}
	if f.count() != 0 {
		t.Fatal("a malformed MAC created a device")
	}
}
