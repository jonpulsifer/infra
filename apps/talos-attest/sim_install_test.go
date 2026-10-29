//go:build cgo

// The install code on the software TPM: an intake pass's confirm answers
// one once fleet-controller has rendered the config, and nothing else does.
package main

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

func TestIntakePassGetsAnInstallCode(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"talos_class": "worker-g5", "smbios_uuid": nil})
	c, fleet := newFakeController(t, http.StatusCreated)
	h.v.Fleet = fleet

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("intake: %v", err)
	}
	reqs := c.requests()
	if len(reqs) != 1 || res.InstallCode == "" || reqs[0].Code != res.InstallCode {
		t.Fatalf("install code %q, render requests %+v", res.InstallCode, reqs)
	}
	if r := reqs[0]; r.Serial != simSerial || r.UUID != simClaim.UUID || r.Node != "testbox" || r.Class != "worker-g5" {
		t.Fatalf("render request %+v", r)
	}
	if d := f.settled(t, simSerial, 2); d.CustomFields["smbios_uuid"] != simClaim.UUID || d.Status != "staged" {
		t.Fatalf("NetBox after the pass: %s %+v", d.Status, d.CustomFields)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"issued"`) || strings.Contains(h.audit.String(), res.InstallCode) {
		t.Fatalf("audit lines:\n%s", h.audit.String())
	}
}

// A device NetBox does not define smbios_uuid for still gets its verdict.
func TestSMBIOSUUIDWaitsForTheField(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"talos_class": "worker-g5"})
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	d := f.settled(t, simSerial, 2)
	if _, ok := d.CustomFields["smbios_uuid"]; ok || d.CustomFields["attest_verdict"] != StatusAttested {
		t.Fatalf("NetBox after the pass: %+v", d.CustomFields)
	}
}

func TestRefusedRenderWithholdsTheCode(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c, fleet := newFakeController(t, http.StatusConflict)
	h.v.Fleet = fleet

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass || res.InstallCode != "" || len(c.requests()) != 1 {
		t.Fatalf("intake with a 409: %+v %v", res, err)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || rec.Status != StatusAttested || !rec.Confirmed {
		t.Fatalf("the pass was not recorded: %+v", rec)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"withheld","reason":"fleet-controller render answered 409 Conflict`) {
		t.Fatalf("audit lines:\n%s", h.audit.String())
	}
}

func TestRenewalRendersNothing(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c, fleet := newFakeController(t, http.StatusCreated)
	h.v.Fleet = fleet
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("renew: %v", err)
	}
	if n := len(c.requests()); n != 1 {
		t.Fatalf("%d render requests after an intake and a renewal, want 1", n)
	}
}
