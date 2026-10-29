package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
)

const fleetSecret = "fleet-test-secret"

// fakeController is fleet-controller's /render: it checks the signature as
// the controller does and answers with status. A 3xx points at /elsewhere,
// which counts what reaches it.
type fakeController struct {
	mu         sync.Mutex
	status     int
	reqs       []RenderRequest
	redirected int
}

func newFakeController(t *testing.T, status int) (*fakeController, *FleetRender) {
	t.Helper()
	c := &fakeController{status: status}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if r.URL.Path == "/elsewhere" {
			c.redirected++
			w.WriteHeader(http.StatusCreated)
			return
		}
		body, _ := io.ReadAll(r.Body)
		mac := hmac.New(sha512.New, []byte(fleetSecret))
		mac.Write(body)
		if r.URL.Path != "/render" || !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(r.Header.Get(FleetSignatureHeader))) {
			t.Errorf("render request %s with a bad signature", r.URL.Path)
			http.Error(w, "bad signature", http.StatusUnauthorized)
			return
		}
		var req RenderRequest
		if err := json.Unmarshal(body, &req); err != nil {
			t.Errorf("render body: %v", err)
		}
		c.reqs = append(c.reqs, req)
		if c.status/100 == 3 {
			w.Header().Set("Location", "/elsewhere")
		}
		w.WriteHeader(c.status)
		_, _ = io.WriteString(w, "controller detail "+req.Code+"\n")
	}))
	t.Cleanup(ts.Close)
	return c, NewFleetRender(ts.URL+"/render", []byte(fleetSecret))
}

func (c *fakeController) requests() []RenderRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]RenderRequest(nil), c.reqs...)
}

func (c *fakeController) followed() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.redirected
}

func fleetVerifier(f *FleetRender, audit io.Writer) *Verifier {
	return &Verifier{Fleet: f, Audit: &Audit{W: audit, Site: "folly"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now}
}

// keySession is a session with an ECC EK and an AK in AKTemplate's shape,
// the keys a code is wrapped to, without a TPM behind them.
func keySession(t *testing.T) *session {
	t.Helper()
	ek, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ak, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := client.AKTemplate
	params := *tmpl.ECCParameters
	params.Point = tpm2.ECPoint{XRaw: ak.X.FillBytes(make([]byte, 32)), YRaw: ak.Y.FillBytes(make([]byte, 32))}
	tmpl.ECCParameters = &params
	akPublic, err := tmpl.Encode()
	if err != nil {
		t.Fatal(err)
	}
	return &session{eks: []VerifiedEK{{Public: &ek.PublicKey, Alg: "ecc", Hash: "ek-under-test"}}, akPublic: akPublic}
}

var installRecord = Record{Machine: "testbox", Serial: "SIM-0001", UUID: "4C4C4544-0000-0000-0000-000000000000", Class: "worker-g5"}

func TestInstallCodeAfterTheControllerRendered(t *testing.T) {
	c, f := newFakeController(t, http.StatusCreated)
	var audit strings.Builder
	wrapped, ok := fleetVerifier(f, &audit).installCode(context.Background(), installRecord, keySession(t))
	reqs := c.requests()
	if !ok || len(reqs) != 1 {
		t.Fatalf("issued %v after %d render requests", ok, len(reqs))
	}
	raw, err := base64.RawURLEncoding.DecodeString(reqs[0].Code)
	if err != nil || len(raw) != 32 {
		t.Fatalf("install code %q is not 32 bytes of base64url: %v", reqs[0].Code, err)
	}
	want := RenderRequest{Serial: "SIM-0001", UUID: "4c4c4544-0000-0000-0000-000000000000", Node: "testbox", Class: "worker-g5", Code: reqs[0].Code}
	if reqs[0] != want {
		t.Fatalf("render request %+v, want %+v", reqs[0], want)
	}
	if wrapped.EKHash != "ek-under-test" || len(wrapped.Credential) < 2 || len(wrapped.Secret) < 2 {
		t.Fatalf("wrapped code %+v", wrapped)
	}
	answer, _ := json.Marshal(wrapped)
	if strings.Contains(string(answer), reqs[0].Code) || strings.Contains(string(answer), base64.StdEncoding.EncodeToString(raw)) {
		t.Fatal("the wrapped code carries the plaintext")
	}
	if !strings.Contains(audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"issued"`) || strings.Contains(audit.String(), reqs[0].Code) {
		t.Fatalf("audit lines:\n%s", audit.String())
	}
}

func TestInstallCodeWithheld(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		uuid   string
		calls  int
		reason string
	}{
		{"no provision workflow", http.StatusConflict, installRecord.UUID, 1, "answered 409"},
		{"cannot render", http.StatusServiceUnavailable, installRecord.UUID, 1, "answered 503"},
		{"anything else", http.StatusOK, installRecord.UUID, 1, "answered 200"},
		{"a redirect", http.StatusTemporaryRedirect, installRecord.UUID, 1, "answered 307"},
		{"no UUID", http.StatusCreated, "", 0, "not 8-4-4-4-12 hex"},
		{"not a UUID", http.StatusCreated, "../../etc/passwd", 0, "not 8-4-4-4-12 hex"},
		{"braced UUID", http.StatusCreated, "{" + installRecord.UUID + "}", 0, "not 8-4-4-4-12 hex"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := newFakeController(t, tc.status)
			var audit strings.Builder
			rec := installRecord
			rec.UUID = tc.uuid
			if _, ok := fleetVerifier(f, &audit).installCode(context.Background(), rec, keySession(t)); ok {
				t.Fatal("a code without the controller's 201")
			}
			if n, followed := len(c.requests()), c.followed(); n != tc.calls || followed != 0 {
				t.Fatalf("%d render requests and %d followed redirects, want %d and 0", n, followed, tc.calls)
			}
			lines := strings.Split(strings.TrimSpace(audit.String()), "\n")
			if len(lines) != 1 || !strings.Contains(lines[0], `"event":"attest.install"`) || !strings.Contains(lines[0], `"status":"withheld"`) || !strings.Contains(lines[0], tc.reason) {
				t.Fatalf("audit lines:\n%s", audit.String())
			}
			if strings.Contains(audit.String(), "controller detail") {
				t.Fatal("the audit line carries the controller's body")
			}
		})
	}
}

func TestInstallCodeWithheldWhenTheControllerIsDown(t *testing.T) {
	f := NewFleetRender("http://127.0.0.1:1/render", []byte(fleetSecret))
	var audit strings.Builder
	if _, ok := fleetVerifier(f, &audit).installCode(context.Background(), installRecord, keySession(t)); ok || !strings.Contains(audit.String(), `"status":"withheld"`) {
		t.Fatalf("issued %v, audit:\n%s", ok, audit.String())
	}
}
