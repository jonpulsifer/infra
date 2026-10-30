//go:build cgo

// The install code on the software TPM: an intake pass's confirm, signed by
// the session's AK, answers one wrapped to the TPM once the installer has
// rendered the config, and nothing else does.
package attest

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/protocol"
)

// confirmWire sits between the client and the service on the confirm. It
// keeps the answer's body. With strangers set it first does what a host that
// saw the session id could: post empty evidence for it on the intake and the
// renewal routes, and confirm with a forged signature. With unsigned set it
// sends the machine's confirm without its signature, as an older client does.
type confirmWire struct {
	strangers bool
	unsigned  bool

	mu       sync.Mutex
	answer   []byte
	stranger []int
}

func (cw *confirmWire) seen() ([]byte, []int) {
	cw.mu.Lock()
	defer cw.mu.Unlock()
	return cw.answer, cw.stranger
}

func (h *harness) watchConfirm(t *testing.T, cw *confirmWire) *confirmWire {
	t.Helper()
	next := h.ts.Config.Handler
	serve := func(path string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		rr := httptest.NewRecorder()
		next.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, path, bytes.NewReader(b)))
		return rr
	}
	h.ts.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/confirm") {
			next.ServeHTTP(w, r)
			return
		}
		var req protocol.ConfirmRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Signature) == 0 {
			t.Errorf("confirm body: %v", err)
			return
		}
		if cw.strangers {
			sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/attest/"), "/confirm")
			forged := append([]byte(nil), req.Signature...)
			forged[len(forged)-1] ^= 0xff
			for _, rr := range []*httptest.ResponseRecorder{
				serve("/v1/attest/"+sid+"/evidence", struct{}{}),
				serve("/v1/renew/"+sid+"/evidence", struct{}{}),
				serve(r.URL.Path, protocol.ConfirmRequest{NVIndexes: req.NVIndexes, Signature: forged}),
			} {
				cw.mu.Lock()
				cw.stranger = append(cw.stranger, rr.Code)
				cw.mu.Unlock()
			}
		}
		if cw.unsigned {
			req.Signature = nil
		}
		rr := serve(r.URL.Path, req)
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
	c := newFakeInstaller(nil)
	h.v.Installer = c
	wire := h.watchConfirm(t, &confirmWire{})

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass {
		t.Fatalf("intake: %v", err)
	}
	// The client unwrapped with its TPM the code the installer was given.
	reqs := c.requests()
	if len(reqs) != 1 || res.InstallCode == "" || reqs[0].Code != res.InstallCode {
		t.Fatalf("install code %q, install requests %+v", res.InstallCode, reqs)
	}
	if r := reqs[0]; r.Serial != simSerial || r.UUID != simClaim.UUID || r.Node != "testbox" || r.Class != "worker-g5" {
		t.Fatalf("install request %+v", r)
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
	if d := f.settled(t, simSerial, 2); d.CustomFields["smbios_uuid"] != simClaim.UUID || d.Status != "planned" {
		t.Fatalf("NetBox after the pass: %s %+v", d.Status, d.CustomFields)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"issued"`) || strings.Contains(h.audit.String(), res.InstallCode) {
		t.Fatalf("audit lines:\n%s", h.audit.String())
	}
}

// A host that saw the session id cannot end a passed session, by posting
// evidence for it or a confirm with a forged signature, and gets no code: the
// machine's own confirm still lands and gets its code.
func TestStrangersCannotTakeAPassedSession(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c := newFakeInstaller(nil)
	h.v.Installer = c
	wire := h.watchConfirm(t, &confirmWire{strangers: true})

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.InstallCode == "" {
		t.Fatalf("intake after the strangers' requests: %+v %v", res, err)
	}
	want := []int{http.StatusNotFound, http.StatusNotFound, http.StatusForbidden}
	if _, stranger := wire.seen(); len(stranger) != len(want) || stranger[0] != want[0] || stranger[1] != want[1] || stranger[2] != want[2] {
		t.Fatalf("the strangers' requests answered %v, want %v", stranger, want)
	}
	if n := len(c.requests()); n != 1 {
		t.Fatalf("%d install requests, want the machine's alone", n)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || !rec.Confirmed {
		t.Fatalf("the machine's confirm was not recorded: %+v", rec)
	}
	if !strings.Contains(h.audit.String(), `"status":"refused","reason":"confirm-signature: the confirm is not signed by the session's AK"`) {
		t.Fatalf("audit lines:\n%s", h.audit.String())
	}
}

// A tink-attest that predates the signature still confirms its pass, and
// gets no code.
func TestUnsignedConfirmPassesWithoutACode(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c := newFakeInstaller(nil)
	h.v.Installer = c
	wire := h.watchConfirm(t, &confirmWire{unsigned: true})

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass || res.InstallCode != "" {
		t.Fatalf("unsigned confirm: %+v %v", res, err)
	}
	if answer, _ := wire.seen(); bytes.Contains(answer, []byte("install_code")) {
		t.Fatalf("an unsigned confirm got a code: %s", answer)
	}
	if n := len(c.requests()); n != 0 {
		t.Fatalf("%d install requests for an unsigned confirm", n)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || rec.Status != StatusAttested || !rec.Confirmed {
		t.Fatalf("the pass was not confirmed: %+v", rec)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"withheld","reason":"unsigned-confirm"`) {
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

// A pass proves a TPM 2.0 and records it when the field is empty, and never
// over an owner's value.
func TestPassRecordsTPMVersionOnlyWhenEmpty(t *testing.T) {
	for _, c := range []struct {
		name   string
		fields map[string]any
		want   any
	}{
		{name: "empty", fields: map[string]any{"talos_class": "worker-g5", "tpm_version": nil}, want: "2.0"},
		{name: "owner value", fields: map[string]any{"talos_class": "worker-g5", "tpm_version": "1.2"}, want: "1.2"},
		{name: "undefined", fields: map[string]any{"talos_class": "worker-g5"}, want: nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeNetBox(t)
			h := newHarness(t, harnessOpts{inventory: emptyInventory, netbox: f})
			f.add("testbox", simSerial, "planned", simMAC, c.fields)
			if _, err := h.run(simSerial, simMAC); err != nil {
				t.Fatal(err)
			}
			d := f.settled(t, simSerial, 2)
			if got := d.CustomFields["tpm_version"]; got != c.want {
				t.Fatalf("tpm_version = %v, want %v (%+v)", got, c.want, d.CustomFields)
			}
		})
	}
}

func TestRefusedRenderWithholdsTheCode(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c := newFakeInstaller(errors.New("no provision asked"))
	h.v.Installer = c

	res, err := h.run(simSerial, simMAC)
	if err != nil || res.Verdict.Verdict != protocol.VerdictPass || res.InstallCode != "" || len(c.requests()) != 1 {
		t.Fatalf("intake with a refused install: %+v %v", res, err)
	}
	if rec, ok, _ := h.v.Store.Record("testbox"); !ok || rec.Status != StatusAttested || !rec.Confirmed {
		t.Fatalf("the pass was not recorded: %+v", rec)
	}
	if !strings.Contains(h.audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"withheld","reason":"no provision asked"`) {
		t.Fatalf("audit lines:\n%s", h.audit.String())
	}
}

func TestRenewalRendersNothing(t *testing.T) {
	h := newHarness(t, harnessOpts{})
	c := newFakeInstaller(nil)
	h.v.Installer = c
	if _, err := h.run(simSerial, simMAC); err != nil {
		t.Fatal(err)
	}
	h.v.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if _, err := h.renew(simSerial); err != nil {
		t.Fatalf("renew: %v", err)
	}
	if n := len(c.requests()); n != 1 {
		t.Fatalf("%d install requests after an intake and a renewal, want 1", n)
	}
}
