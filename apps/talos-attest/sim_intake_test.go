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
// pending even while the window is open.
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
	if !h.intakeAudited("SIM-STUB") || !strings.Contains(h.audit.String(), "bound to the declared stub; policy declared") {
		t.Fatalf("no attest.intake line for the binding:\n%s", h.audit.String())
	}

	h.writeWindow(t, time.Now().Add(time.Hour))
	h.pending(t, simSerial)
	if f.count() != 1 || h.intakeAudited(simSerial) {
		t.Fatal("the declared policy admitted a serial with no stub")
	}
	if code, st := h.admin(t, http.MethodGet, "/intake", ""); code != http.StatusOK || !st.Open || st.Policy != intakePolicyDeclared {
		t.Fatalf("GET /intake: %d %+v", code, st)
	}
	if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_intake_open{policy="declared"} 1`) {
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
