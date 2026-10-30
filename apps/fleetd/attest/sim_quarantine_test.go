//go:build cgo

// A quarantine whose NetBox write failed still withdraws the identity, and
// an unattended HookOS boot never quarantines.
package attest

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// NetBox mode with the quarantine's write failed: the service's own
// quarantine beats NetBox's stale pass.
func TestQuarantineStandsWhenItsNetBoxWriteFailed(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, h.bound(map[string]any{"talos_class": "worker-g5"}))
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

// activeTestbox is a node that passed and runs: active in NetBox, with its
// pins, so a later HookOS boot is an intake that may quarantine it.
func activeTestbox(t *testing.T) (*harness, *fakeNetBox) {
	t.Helper()
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, h.bound(map[string]any{"talos_class": "worker-g5"}))
	f.set(simSerial, func(d *fakeDevice) {
		d.CustomFields["ek_hash"], d.CustomFields["ek_hash_ecc"] = h.hashes["rsa"], h.hashes["ecc"]
	})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	f.settled(t, simSerial, 2)
	f.set(simSerial, func(d *fakeDevice) { d.Status = "active" })
	h.tamper = func(r *protocol.EvidenceRequest) { r.EventLog = readFile(t, "testdata/optiplex-eventlog.bin") }
	return h, f
}

// A worker that falls back to PXE, after a BIOS reset or a disk fault, boots
// HookOS while no run expects it. Its failed attestation is refused and
// records nothing: the node keeps its verdict and its LDevID, the device's
// journal says why, and the reason is counted for the owner's alert. A
// lookup that fails counts as unexpected.
func TestUnattendedHookOSBootNeverQuarantines(t *testing.T) {
	for name, expected := range map[string]func(context.Context, string) (bool, error){
		"not expected":   func(context.Context, string) (bool, error) { return false, nil },
		"lookup failure": func(context.Context, string) (bool, error) { return false, errors.New("NetBox is down") },
	} {
		t.Run(name, func(t *testing.T) {
			h, f := activeTestbox(t)
			h.v.Expected = expected
			r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }())
			if r.Verdict.Verdict != protocol.VerdictRefused || r.Verdict.Reason != reasonUnattended {
				t.Fatalf("unattended boot: %+v", r.Verdict)
			}
			if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusAttested {
				t.Fatalf("an unattended boot changed the record: %+v", rec)
			}
			if d := f.bySerial(simSerial); d.Status != "active" || d.CustomFields["attest_verdict"] != StatusAttested {
				t.Fatalf("an unattended boot changed NetBox: %s %+v", d.Status, d.CustomFields)
			}
			if code, _ := h.get("/devid/" + simSerial); code != http.StatusOK {
				t.Fatalf("an unattended boot withdrew the DevID: %d", code)
			}
			if name == "not expected" && !f.journaled("unexpected HookOS boot failed attestation") {
				t.Fatal("no journal entry for the unattended boot")
			}
			if m, _ := h.v.Metrics(); !strings.Contains(m, `talos_attest_verdicts_total{verdict="refused",reason="unattended-boot"} 1`) {
				t.Fatalf("the unattended boot went uncounted:\n%s", m)
			}
		})
	}
}

// A boot a run expects, such as a provision's, still quarantines a failed
// attestation after the TPM's proof.
func TestExpectedHookOSBootStillQuarantines(t *testing.T) {
	h, f := activeTestbox(t)
	h.v.Expected = func(context.Context, string) (bool, error) { return true, nil }
	if r := refusal(t, func() error { _, err := h.run(simSerial, simMAC); return err }()); r.Verdict.Verdict != protocol.VerdictQuarantine {
		t.Fatalf("expected boot: %+v", r.Verdict)
	}
	if rec, _, _ := h.v.Store.Record("testbox"); rec.Status != StatusQuarantined {
		t.Fatalf("the expected boot did not quarantine: %+v", rec)
	}
	if d := f.settled(t, simSerial, 3); !strings.HasPrefix(d.CustomFields["attest_verdict"].(string), "quarantined") {
		t.Fatalf("NetBox after the expected boot: %+v", d.CustomFields)
	}
}
