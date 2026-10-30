//go:build cgo

// Intake on the software TPM: the planned stub the owner declared is the
// authorization, and a serial NetBox does not know waits for the owner's
// approval.
package attest

import (
	"strings"
	"testing"

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

// approve records the owner's approval of the harness TPM's EKs for serial,
// as POST /approve does after a first intake.
func (h *harness) approve(t *testing.T, serial string) {
	t.Helper()
	if err := h.v.Store.Approve(serial, []string{h.hashes["rsa"], h.hashes["ecc"]}); err != nil {
		t.Fatal(err)
	}
}

// The box that attests as a declared stub's serial passes on its EK
// certificates and binds to it; the stub stays planned until its node
// fetches its config. A serial with no stub stays pending.
func TestDeclaredStubBinds(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})

	f.add("swell", "SIM-STUB", statusPlanned, "", map[string]any{"talos_class": "worker-g5"})
	if res, err := h.run("SIM-STUB", simMAC); err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("declared stub: %v", err)
	}
	d := f.settled(t, "SIM-STUB", 2)
	if d.Name != "swell" || d.Status != statusPlanned || d.CustomFields["ek_hash"] != h.hashes["rsa"] || f.count() != 1 {
		t.Fatalf("stub after its pass: %s %s %+v (%d devices)", d.Name, d.Status, d.CustomFields, f.count())
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

// A declared stub still needs a pinned maker's certificate on every EK.
func TestDeclaredStubKeepsAnUncertifiedEKPending(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f, noEKCerts: true})
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
// another box bound, pinned or moved out of planned meanwhile refuses this
// one, and its pins stay.
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
		{"no longer planned", reasonStatus, func(_ *fakeNetBox, d *fakeDevice) { d.Status = "active" }},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
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

// When NetBox learns an approved serial between the start and the
// evidence, the start's rules decide for that device.
func TestFirstSightRechecksADeviceNetBoxLearned(t *testing.T) {
	for _, c := range []struct {
		name, status, mac, verdict, reason string
	}{
		{"planned with another MAC", statusPlanned, "aa:bb:cc:dd:ee:ff", protocol.VerdictRefused, reasonMACMismatch},
		{"active", "active", simMAC, protocol.VerdictRefused, reasonStatus},
		{"planned with this MAC", statusPlanned, simMAC, protocol.VerdictPass, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			h.approve(t, simSerial)
			h.tamper = func(*protocol.EvidenceRequest) { f.add("realbox", simSerial, c.status, c.mac, nil) }
			res, err := h.run(simSerial, simMAC)
			if c.verdict == protocol.VerdictPass {
				if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
					t.Fatalf("%v", err)
				}
				if d := f.settled(t, simSerial, 2); d.Name != "realbox" || d.Status != statusPlanned || f.count() != 1 {
					t.Fatalf("device after the pass: %+v (%d devices)", d, f.count())
				}
				return
			}
			if r := refusal(t, err); r.Verdict.Verdict != c.verdict || r.Verdict.Reason != c.reason {
				t.Fatalf("%+v", r.Verdict)
			}
			if d := f.bySerial(simSerial); d.Patches != 0 || d.CustomFields["ek_hash"] != nil || d.Name != "realbox" || f.count() != 1 {
				t.Fatalf("the refusal wrote: %+v (%d devices)", d, f.count())
			}
		})
	}
}

// A claim that may become a NetBox device carries a MAC that reads as one.
func TestFirstSightRefusesAMalformedMAC(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	h.approve(t, simSerial)
	if r := refusal(t, func() error { _, err := h.run(simSerial, "zz:zz"); return err }()); r.Verdict.Reason != reasonMACInvalid {
		t.Fatalf("%+v", r.Verdict)
	}
	if f.count() != 0 {
		t.Fatal("a malformed MAC created a device")
	}
}
