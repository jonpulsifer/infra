//go:build cgo

// The install code on the software TPM: an intake pass's confirm, signed by
// the session's AK, answers one wrapped to the TPM once fleet-controller has
// rendered the config, and nothing else does.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/talos-attest/protocol"
)

// confirmWire sits between the client and the service on the confirm: it
// keeps the answer's body, and first replays the confirm as a stranger who
// saw the session would, without the AK's signature and with a forged one.
type confirmWire struct {
	mu       sync.Mutex
	answer   []byte
	stranger []int
}

func (cw *confirmWire) seen() ([]byte, []int) {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	return cw.answer, cw.stranger
}

func (h *harness) watchConfirm(t *testing.T) *confirmWire {
	t.Helper()
	cw := &confirmWire{}
	next := h.ts.Config.Handler
	h.ts.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/confirm") {
			next.ServeHTTP(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req protocol.ConfirmRequest
		if err := json.Unmarshal(body, &req); err != nil || len(req.Signature) == 0 {
			t.Errorf("confirm body %s: %v", body, err)
			return
		}
		forged := append([]byte(nil), req.Signature...)
		forged[len(forged)-1] ^= 0xff
		for _, sig := range [][]byte{nil, forged} {
			b, _ := json.Marshal(protocol.ConfirmRequest{NVIndexes: req.NVIndexes, Signature: sig})
			rr := httptest.NewRecorder()
			next.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, r.URL.Path, bytes.NewReader(b)))
			cw.mu.Lock()
			cw.stranger = append(cw.stranger, rr.Code)
			cw.mu.Unlock()
		}
		rr := httptest.NewRecorder()
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(rr, r)
		cw.mu.Lock()
		cw.answer = rr.Body.Bytes()
		cw.mu.Unlock()
		for k, v := range rr.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rr.Code)
		_, _ = w.Write(rr.Body.Bytes())
	})
	return cw
}

func TestIntakePassGetsAnInstallCode(t *testing.T) {
	f := newFakeNetBox(t)
	h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
	f.add("testbox", simSerial, "planned", simMAC, map[string]any{"talos_class": "worker-g5", "smbios_uuid": nil})
	c, fleet := newFakeController(t, http.StatusCreated)
	h.v.Fleet = fleet
	wire := h.watchConfirm(t)

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("intake: %v", err)
	}
	// The client unwrapped with its TPM the code the controller was given.
	reqs := c.requests()
	if len(reqs) != 1 || res.InstallCode == "" || reqs[0].Code != res.InstallCode {
		t.Fatalf("install code %q, render requests %+v", res.InstallCode, reqs)
	}
	if r := reqs[0]; r.Serial != simSerial || r.UUID != simClaim.UUID || r.Node != "testbox" || r.Class != "worker-g5" {
		t.Fatalf("render request %+v", r)
	}
	// The answer on the plain-HTTP device flow carries the code only wrapped.
	answer, _ := wire.seen()
	raw, _ := base64.RawURLEncoding.DecodeString(res.InstallCode)
	var confirmed protocol.ConfirmResponse
	if err := json.Unmarshal(answer, &confirmed); err != nil || len(confirmed.InstallCodeCredential) == 0 || len(raw) != 32 {
		t.Fatalf("confirm answer %s: %v", answer, err)
	}
	if bytes.Contains(answer, []byte(res.InstallCode)) || bytes.Contains(answer, []byte(base64.StdEncoding.EncodeToString(raw))) || bytes.Contains(answer, raw) {
		t.Fatalf("the confirm answer carries the plaintext code: %s", answer)
	}
	if d := f.settled(t, simSerial, 2); d.CustomFields["smbios_uuid"] != simClaim.UUID || d.Status != "staged" {
		t.Fatalf("NetBox after the pass: %s %+v", d.Status, d.CustomFields)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"issued"`) || strings.Contains(h.audit.String(), res.InstallCode) {
		t.Fatalf("audit lines:\n%s", h.audit.String())
	}
}

// A confirm the session's AK did not sign is refused and leaves the session
// for the machine: a stranger who saw the session id takes nothing.
func TestConfirmNeedsTheAKSignature(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c, fleet := newFakeController(t, http.StatusCreated)
	h.v.Fleet = fleet
	wire := h.watchConfirm(t)

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.InstallCode == "" {
		t.Fatalf("intake after the strangers' confirms: %+v %v", res, err)
	}
	if _, stranger := wire.seen(); len(stranger) != 2 || stranger[0] != http.StatusForbidden || stranger[1] != http.StatusForbidden {
		t.Fatalf("the strangers' confirms answered %v, want two 403s", stranger)
	}
	if n := len(c.requests()); n != 1 {
		t.Fatalf("%d render requests, want the machine's alone", n)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || !rec.Confirmed {
		t.Fatalf("the machine's confirm was not recorded: %+v", rec)
	}
	if !strings.Contains(h.audit.String(), `"status":"refused","reason":"confirm-signature: the confirm carries no AK signature"`) ||
		!strings.Contains(h.audit.String(), `"reason":"confirm-signature: the confirm is not signed by the session's AK"`) {
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
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"withheld","reason":"fleet-controller render answered 409"`) {
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
