package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

const testSerial = "CZC1234"

type fakeAttestor struct {
	mu    sync.Mutex
	v     Verdict
	err   error
	calls []string
}

func (f *fakeAttestor) Verdict(_ context.Context, serial string) (Verdict, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, serial)
	return f.v, f.err
}

func (f *fakeAttestor) set(v Verdict, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.v, f.err = v, err
}

func withAutoApproval(t *testing.T) (*harness, *fakeAttestor) {
	t.Helper()
	h := newHarness(t)
	f := &fakeAttestor{}
	h.srv.Auto = &AutoApproval{Attest: f, Window: 30 * time.Minute}
	return h, f
}

func (h *harness) attestedAgo(f *fakeAttestor, d time.Duration) time.Time {
	at := h.clock.Now().Add(-d)
	f.set(Verdict{Status: "attested", AttestedAt: at}, nil)
	return at
}

func (h *harness) startDeviceForm(v url.Values) (deviceCode, userCode string) {
	h.t.Helper()
	code, m, body := h.do(h.public, form("/device/code", v))
	if code != http.StatusOK {
		h.t.Fatalf("device code: %d %s", code, body)
	}
	return m["device_code"].(string), m["user_code"].(string)
}

func TestAttestedMachineIsApprovedWithoutAClick(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, 5*time.Minute)
	dc, _ := h.startDevice(testUUID)

	if len(f.calls) != 1 || f.calls[0] != testSerial {
		t.Fatalf("verdict queries = %v, want one for %s", f.calls, testSerial)
	}
	code, m := h.poll(dc, testUUID)
	if code != 200 || m["access_token"] == "" {
		t.Fatalf("the first poll after an attested request: %d %v", code, m)
	}
	msg := h.notes.last(t, testUUID, 1)
	for _, want := range []string{"auto-approved after attestation", "**riptide**", testSerial} {
		if !strings.Contains(msg, want) {
			t.Fatalf("the note lacks %q:\n%s", want, msg)
		}
	}
	code, _, body := h.do(h.public, getConfig(m["access_token"].(string), configQuery(testUUID)))
	if code != 200 || body != "version: v1alpha1\n# riptide\n" {
		t.Fatalf("config: %d %q", code, body)
	}
}

func TestOneAttestationApprovesOneRequest(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, time.Minute)
	h.startDevice(testUUID)

	other := "4c4c4544-0000-0000-0000-000000000002"
	dc, uc := h.startDevice(other)
	if code, m := h.poll(dc, other); code != 400 || m["error"] != "authorization_pending" {
		t.Fatalf("a second request on one attestation: %d %v", code, m)
	}
	if msg := h.notes.last(t, other, 1); !strings.Contains(msg, "Not approved automatically: its latest attestation already approved a request.") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}
	if code, _ := h.approve(uc, "riptide"); code != 200 {
		t.Fatal("the click flow does not approve after a refused auto-approval")
	}

	h.clock.Add(time.Minute)
	h.attestedAgo(f, 0)
	third := "4c4c4544-0000-0000-0000-000000000003"
	dc, _ = h.startDevice(third)
	if code, _ := h.poll(dc, third); code != 200 {
		t.Fatalf("a fresh attestation does not approve: %d", code)
	}
}

func TestAutoApprovalNeedsAFreshMatchingAttestation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		setup func(h *harness, f *fakeAttestor) url.Values
		why   string
	}{
		{"stale", func(h *harness, f *fakeAttestor) url.Values {
			h.attestedAgo(f, 31*time.Minute)
			return deviceForm(testUUID)
		}, "it last attested 31m0s ago, more than 30m0s"},
		{"quarantined", func(h *harness, f *fakeAttestor) url.Values {
			f.set(Verdict{Status: "quarantined", AttestedAt: h.clock.Now()}, nil)
			return deviceForm(testUUID)
		}, "the attest service reports it quarantined"},
		{"unknown", func(_ *harness, f *fakeAttestor) url.Values {
			f.set(Verdict{Status: "unknown"}, nil)
			return deviceForm(testUUID)
		}, "the attest service reports it unknown"},
		{"attest service down", func(_ *harness, f *fakeAttestor) url.Values {
			f.set(Verdict{}, errors.New("connection refused"))
			return deviceForm(testUUID)
		}, "the attest service did not answer: connection refused"},
		{"attested as another node", func(h *harness, f *fakeAttestor) url.Values {
			f.set(Verdict{Status: "attested", AttestedAt: h.clock.Now(), Node: "optiplex"}, nil)
			return deviceForm(testUUID)
		}, "it attested as optiplex, but its MAC is riptide's"},
		{"attested with another uuid", func(h *harness, f *fakeAttestor) url.Values {
			f.set(Verdict{Status: "attested", AttestedAt: h.clock.Now(), UUID: "4c4c4544-ffff"}, nil)
			return deviceForm(testUUID)
		}, "it attested with uuid 4c4c4544-ffff"},
		{"dated in the future", func(h *harness, f *fakeAttestor) url.Values {
			h.attestedAgo(f, -time.Hour)
			return deviceForm(testUUID)
		}, "its attestation is dated in the future"},
		{"MAC of no node", func(h *harness, f *fakeAttestor) url.Values {
			h.attestedAgo(f, 0)
			v := deviceForm(testUUID)
			v.Set("mac", "aa:aa:aa:aa:aa:aa")
			return v
		}, "its MAC matches no node"},
		{"no serial", func(h *harness, f *fakeAttestor) url.Values {
			h.attestedAgo(f, 0)
			v := deviceForm(testUUID)
			v.Set("serial", "")
			return v
		}, "the request names no serial"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, f := withAutoApproval(t)
			dc, _ := h.startDeviceForm(tc.setup(h, f))
			if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "authorization_pending" {
				t.Fatalf("poll: %d %v", code, m)
			}
			msg := h.notes.last(t, testUUID, 1)
			if !strings.Contains(msg, "waiting for approval") || !strings.Contains(msg, "Not approved automatically: "+tc.why+".") {
				t.Fatalf("the prompt does not ask for a click and say %q:\n%s", tc.why, msg)
			}
		})
	}
}

func TestAutoApprovalRenderFailureReleasesTheAttestation(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, time.Minute)
	h.render.fail = errors.New("boom")
	dc, _ := h.startDevice(testUUID)
	if code, _ := h.poll(dc, testUUID); code != 400 {
		t.Fatal("approved with a config that did not render")
	}
	if msg := h.notes.last(t, testUUID, 1); !strings.Contains(msg, "Not approved automatically: its config did not render.") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}

	h.render.fail = nil
	dc, _ = h.startDevice(testUUID)
	if code, _ := h.poll(dc, testUUID); code != 200 {
		t.Fatal("the attestation was spent on a request it did not approve")
	}
}

func TestWithoutAnAttestURLEveryRequestNeedsAClick(t *testing.T) {
	h := newHarness(t)
	dc, _ := h.startDevice(testUUID)
	if code, _ := h.poll(dc, testUUID); code != 400 {
		t.Fatal("approved without a click or an attest service")
	}
	if msg := h.notes.last(t, testUUID, 1); strings.Contains(msg, "automatically") {
		t.Fatalf("the prompt mentions auto-approval while it is off:\n%s", msg)
	}
}

func TestAttestClient(t *testing.T) {
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.EscapedPath()
		switch r.URL.Path {
		case "/verdict/CZC 1234":
			_, _ = w.Write([]byte(`{"status":"attested","attested_at":"2026-10-28T12:00:00Z","node":"riptide"}`))
		case "/verdict/broken":
			w.WriteHeader(http.StatusBadGateway)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := &AttestClient{BaseURL: srv.URL, Client: srv.Client()}
	ctx := context.Background()

	v, err := c.Verdict(ctx, "CZC 1234")
	if err != nil || v.Status != "attested" || v.Node != "riptide" || !v.AttestedAt.Equal(time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("verdict = %+v, %v", v, err)
	}
	if path != "/verdict/CZC%201234" {
		t.Fatalf("path = %s, want the serial escaped", path)
	}
	if v, err := c.Verdict(ctx, "nobody"); err != nil || v.Status != "unknown" {
		t.Fatalf("a serial the service does not know: %+v, %v", v, err)
	}
	if _, err := c.Verdict(ctx, "broken"); err == nil {
		t.Fatal("a 502 is not an error")
	}
}
