package main

import (
	"context"
	"crypto/hmac"
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
)

const fleetSecret = "fleet-test-secret"

// fakeController is fleet-controller's /render: it checks the signature as
// the controller does and answers with status.
type fakeController struct {
	mu     sync.Mutex
	status int
	reqs   []RenderRequest
}

func newFakeController(t *testing.T, status int) (*fakeController, *FleetRender) {
	t.Helper()
	c := &fakeController{status: status}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		c.mu.Lock()
		c.reqs = append(c.reqs, req)
		status := c.status
		c.mu.Unlock()
		w.WriteHeader(status)
		_, _ = io.WriteString(w, http.StatusText(status)+"\n")
	}))
	t.Cleanup(ts.Close)
	return c, &FleetRender{URL: ts.URL + "/render", Secret: []byte(fleetSecret), Client: ts.Client()}
}

func (c *fakeController) requests() []RenderRequest {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]RenderRequest(nil), c.reqs...)
}

func fleetVerifier(f *FleetRender, audit io.Writer) *Verifier {
	return &Verifier{Fleet: f, Audit: &Audit{W: audit, Site: "folly"}, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now}
}

var installRecord = Record{Machine: "testbox", Serial: "SIM-0001", UUID: "4C4C4544-0000-0000-0000-000000000000", Class: "worker-g5"}

func TestInstallCodeAfterTheControllerRendered(t *testing.T) {
	c, f := newFakeController(t, http.StatusCreated)
	var audit strings.Builder
	code := fleetVerifier(f, &audit).installCode(context.Background(), installRecord)
	raw, err := base64.RawURLEncoding.DecodeString(code)
	if err != nil || len(raw) != 32 {
		t.Fatalf("install code %q is not 32 bytes of base64url: %v", code, err)
	}
	reqs := c.requests()
	want := RenderRequest{Serial: "SIM-0001", UUID: "4c4c4544-0000-0000-0000-000000000000", Node: "testbox", Class: "worker-g5", Code: code}
	if len(reqs) != 1 || reqs[0] != want {
		t.Fatalf("render requests %+v, want %+v", reqs, want)
	}
	if !strings.Contains(audit.String(), `"event":"attest.install","site":"folly","node":"testbox","serial":"SIM-0001","class":"worker-g5","status":"issued"`) || strings.Contains(audit.String(), code) {
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
		{"no provision workflow", http.StatusConflict, installRecord.UUID, 1, "409 Conflict"},
		{"cannot render", http.StatusServiceUnavailable, installRecord.UUID, 1, "503 Service Unavailable"},
		{"anything else", http.StatusOK, installRecord.UUID, 1, "200 OK"},
		{"no UUID", http.StatusCreated, "", 0, "no SMBIOS UUID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := newFakeController(t, tc.status)
			var audit strings.Builder
			rec := installRecord
			rec.UUID = tc.uuid
			if code := fleetVerifier(f, &audit).installCode(context.Background(), rec); code != "" {
				t.Fatalf("a code without the controller's 201: %q", code)
			}
			if n := len(c.requests()); n != tc.calls {
				t.Fatalf("%d render requests, want %d", n, tc.calls)
			}
			lines := strings.Split(strings.TrimSpace(audit.String()), "\n")
			if len(lines) != 1 || !strings.Contains(lines[0], `"event":"attest.install"`) || !strings.Contains(lines[0], `"status":"withheld"`) || !strings.Contains(lines[0], tc.reason) {
				t.Fatalf("audit lines:\n%s", audit.String())
			}
			for _, r := range c.requests() {
				if strings.Contains(audit.String(), r.Code) {
					t.Fatal("the audit line carries the code")
				}
			}
		})
	}
}

func TestInstallCodeWithheldWhenTheControllerIsDown(t *testing.T) {
	_, f := newFakeController(t, http.StatusCreated)
	f.URL = "http://127.0.0.1:1/render"
	var audit strings.Builder
	if code := fleetVerifier(f, &audit).installCode(context.Background(), installRecord); code != "" || !strings.Contains(audit.String(), `"status":"withheld"`) {
		t.Fatalf("code %q, audit:\n%s", code, audit.String())
	}
}
