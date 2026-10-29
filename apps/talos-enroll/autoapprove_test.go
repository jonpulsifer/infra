package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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

// withAutoApproval turns the harness into one behind NetBox and the attest
// service: the directory's nodes come from netbox, riptide is staged with a
// fresh pass that the verdict binds to the test UUID, and an attested worker
// needs no click.
func withAutoApproval(t *testing.T) (*harness, *fakeAttestor) {
	t.Helper()
	h := newHarness(t)
	f := &fakeAttestor{}
	h.srv.Auto = &AutoApproval{Attest: f, Dir: h.dir, Window: 2 * time.Hour}
	for _, name := range []string{"riptide", "optiplex"} {
		h.dir.set(name, func(n *Node) { n.Source = "netbox"; n.ID = 7 })
	}
	return h, f
}

// attestedAgo records a pass d ago in NetBox and in the verdict.
func (h *harness) attestedAgo(f *fakeAttestor, d time.Duration) time.Time {
	at := h.clock.Now().Add(-d)
	h.dir.set("riptide", func(n *Node) {
		n.Status = "staged"
		n.Verdict = "attested"
		n.LastAttested = at
		n.ConsumedAt = time.Time{}
	})
	if f != nil {
		f.set(Verdict{Status: "attested", AttestedAt: at, Node: "riptide", UUID: testUUID}, nil)
	}
	return at
}

func TestAttestedMachineIsApprovedWithoutAClick(t *testing.T) {
	h, f := withAutoApproval(t)
	at := h.attestedAgo(f, 5*time.Minute)
	dc, _ := h.startDevice(testUUID)

	if len(f.calls) != 1 || f.calls[0] != testSerial {
		t.Fatalf("verdict queries = %v, want one for %s", f.calls, testSerial)
	}
	// The spend reached NetBox before the token existed.
	if sp := h.dir.spent(); len(sp) != 1 || sp[0].node != "riptide" || !sp[0].at.Equal(h.clock.Now()) {
		t.Fatalf("the spend must be recorded at approval: %v", sp)
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
	h.clock.Add(time.Minute)
	code, _, body := h.do(h.public, getConfig(m["access_token"].(string), configQuery(testUUID)))
	if code != 200 || body != "version: v1alpha1\n# riptide\n" {
		t.Fatalf("config: %d %q", code, body)
	}
	rel := h.dir.released()
	if len(rel) != 1 || rel[0].node != "riptide" || !rel[0].at.Equal(h.clock.Now()) {
		t.Fatalf("the release must be recorded at its own time: %v", rel)
	}
	n, _ := h.dir.ByName(context.Background(), "riptide")
	if n.Status != "active" || !n.ConsumedAt.After(at) {
		t.Fatalf("after the release NetBox must hold active and a consumed time past the pass: %+v", n)
	}
	if ok, why := n.Attested(); ok {
		t.Fatalf("a spent attestation still approves: %s", why)
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
	if msg := h.notes.last(t, other, 1); !strings.Contains(msg, "Not approved automatically: its latest attestation already released a config.") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}
	if code, _ := h.approve(uc, "riptide"); code != 200 {
		t.Fatal("the click flow does not approve after a refused auto-approval")
	}

	h.clock.Add(time.Minute)
	h.attestedAgo(f, 0)
	f.set(Verdict{Status: "attested", AttestedAt: h.clock.Now(), Node: "riptide", UUID: "4c4c4544-0000-0000-0000-000000000003"}, nil)
	third := "4c4c4544-0000-0000-0000-000000000003"
	dc, _ = h.startDevice(third)
	if code, _ := h.poll(dc, third); code != 200 {
		t.Fatalf("a fresh attestation does not approve: %d", code)
	}
}

// A failover: a fresh process with no reservations sees NetBox as the first
// one left it. Because the first spent the attestation before issuing its
// token, the second refuses.
func TestFailoverCannotSpendTheSameAttestation(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, time.Minute)
	h.startDevice(testUUID)

	fresh := newHarness(t)
	fresh.dir = h.dir
	fresh.srv.Dir = h.dir
	fresh.srv.Auto = &AutoApproval{Attest: f, Dir: h.dir, Window: 2 * time.Hour}
	dc, _ := fresh.startDevice(testUUID)
	if code, _ := fresh.poll(dc, testUUID); code != 400 {
		t.Fatal("a fresh process spent an attestation that NetBox holds as spent")
	}
	if msg := fresh.notes.last(t, testUUID, 1); !strings.Contains(msg, "already released a config") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}
}

// A pass before a click release is spent by that release: NetBox's
// attest_consumed_at moves past last_attested whoever approved.
func TestAClickReleaseSpendsAnEarlierPass(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, time.Minute)
	h.dir.set("riptide", func(n *Node) { n.Status = "active" }) // not staged, so no auto-approval
	dc, uc := h.startDevice(testUUID)
	h.approve(uc, "riptide")
	_, m := h.poll(dc, testUUID)
	h.clock.Add(time.Minute)
	if code, _, _ := h.do(h.public, getConfig(m["access_token"].(string), configQuery(testUUID))); code != 200 {
		t.Fatal("config")
	}

	h.dir.set("riptide", func(n *Node) { n.Status = "staged" })
	again := "4c4c4544-0000-0000-0000-000000000005"
	f.set(Verdict{Status: "attested", AttestedAt: h.clock.Now().Add(-2 * time.Minute), Node: "riptide", UUID: again}, nil)
	dc, _ = h.startDevice(again)
	if code, _ := h.poll(dc, again); code != 400 {
		t.Fatal("a pass from before a click release approved a later request")
	}
	if msg := h.notes.last(t, again, 1); !strings.Contains(msg, "already released a config") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}
}

func TestSpendFailureRefusesAutoApproval(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, time.Minute)
	h.dir.spendFail = errors.New("netbox 503")
	dc, uc := h.startDevice(testUUID)
	if code, _ := h.poll(dc, testUUID); code != 400 {
		t.Fatal("approved without the spend recorded")
	}
	if msg := h.notes.last(t, testUUID, 1); !strings.Contains(msg, "NetBox did not record the spend") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}
	h.dir.spendFail = nil
	if code, _ := h.approve(uc, "riptide"); code != 200 {
		t.Fatal("the click path must still work")
	}
	again := "4c4c4544-0000-0000-0000-000000000006"
	f.set(Verdict{Status: "attested", AttestedAt: h.clock.Now(), Node: "riptide", UUID: again}, nil)
	h.dir.set("riptide", func(n *Node) { n.Status = "staged" })
	dc, _ = h.startDevice(again)
	if code, _ := h.poll(dc, again); code != 200 {
		t.Fatal("the reservation was not returned after the failed spend")
	}
}

func TestAutoApprovalReadsTheLifecycleAndTheVerdict(t *testing.T) {
	cases := map[string]struct {
		mutate func(h *harness, f *fakeAttestor)
		why    string
	}{
		"active, not staged": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.Status = "active" }) },
			"NetBox has it active, not staged",
		},
		"quarantined": {
			func(h *harness, _ *fakeAttestor) {
				h.dir.set("riptide", func(n *Node) { n.Verdict = "quarantined: ek-chain" })
			},
			"records its attestation as quarantined: ek-chain",
		},
		"no attestation": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.Verdict = "" }) },
			"records no attestation",
		},
		"already consumed": {
			func(h *harness, _ *fakeAttestor) {
				h.dir.set("riptide", func(n *Node) { n.ConsumedAt = n.LastAttested.Add(time.Second) })
			},
			"already released a config",
		},
		"unreadable consumed time": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.ConsumedUnknown = true }) },
			"counts as spent",
		},
		"another MAC": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.MAC = "aa:aa:aa:aa:aa:aa" }) },
			"its MAC is not riptide's in NetBox",
		},
		"no class": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.Class = "" }) },
			"NetBox gives riptide no class",
		},
		"a control plane": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.Class = "controlplane" }) },
			"a control plane, which is approved only by a click",
		},
		"unknown serial": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.Serial = "OTHER" }) },
			"NetBox knows no device with its serial",
		},
		"from the inventory": {
			func(h *harness, _ *fakeAttestor) { h.dir.set("riptide", func(n *Node) { n.Source = "inventory" }) },
			"the inventory holds no attestation",
		},
		"past the window": {
			func(h *harness, f *fakeAttestor) { h.attestedAgo(f, 3*time.Hour) },
			"more than 2h0m0s",
		},
		"verdict unknown": {
			func(_ *harness, f *fakeAttestor) { f.set(Verdict{Status: "unknown"}, nil) },
			"the attest service reports it unknown",
		},
		"verdict quarantined": {
			func(_ *harness, f *fakeAttestor) {
				f.set(Verdict{Status: "quarantined", Node: "riptide", UUID: testUUID}, nil)
			},
			"the attest service reports it quarantined",
		},
		"verdict for another uuid": {
			func(_ *harness, f *fakeAttestor) {
				f.set(Verdict{Status: "attested", Node: "riptide", UUID: "4c4c4544-0000-0000-0000-00000000dead"}, nil)
			},
			"not the request's",
		},
		"verdict for another node": {
			func(_ *harness, f *fakeAttestor) {
				f.set(Verdict{Status: "attested", Node: "shale", UUID: testUUID}, nil)
			},
			`it attested as "shale", not as riptide`,
		},
		"attest service down": {
			func(_ *harness, f *fakeAttestor) { f.set(Verdict{}, errors.New("connection refused")) },
			"the attest service did not answer",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h, f := withAutoApproval(t)
			h.attestedAgo(f, time.Minute)
			tc.mutate(h, f)
			dc, _ := h.startDevice(testUUID)
			if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "authorization_pending" {
				t.Fatalf("approved: %d %v", code, m)
			}
			if msg := h.notes.last(t, testUUID, 1); !strings.Contains(msg, tc.why) {
				t.Fatalf("the prompt lacks %q:\n%s", tc.why, msg)
			}
			if sp := h.dir.spent(); len(sp) != 0 {
				t.Fatalf("a refused approval spent the attestation: %v", sp)
			}
		})
	}
}

func TestAutoApprovalRenderFailureReleasesTheAttestation(t *testing.T) {
	h, f := withAutoApproval(t)
	h.attestedAgo(f, time.Minute)
	h.render.fail = ErrNoClass
	dc, _ := h.startDevice(testUUID)
	if code, _ := h.poll(dc, testUUID); code != 400 {
		t.Fatal("approved with a failing render")
	}
	if msg := h.notes.last(t, testUUID, 1); !strings.Contains(msg, "its config did not render") {
		t.Fatalf("the prompt does not say why:\n%s", msg)
	}
	if sp := h.dir.spent(); len(sp) != 0 {
		t.Fatalf("a failed render spent the attestation: %v", sp)
	}
	h.render.fail = nil
	again := "4c4c4544-0000-0000-0000-000000000004"
	f.set(Verdict{Status: "attested", Node: "riptide", UUID: again}, nil)
	dc, _ = h.startDevice(again)
	if code, _ := h.poll(dc, again); code != 200 {
		t.Fatal("the attestation was not returned after the failed render")
	}
}

func TestWithoutAutoApprovalEveryRequestNeedsAClick(t *testing.T) {
	h := newHarness(t)
	h.dir.set("riptide", func(n *Node) { n.Source = "netbox" })
	h.attestedAgo(nil, time.Minute)
	dc, _ := h.startDevice(testUUID)
	if code, m := h.poll(dc, testUUID); code != 400 || m["error"] != "authorization_pending" {
		t.Fatalf("approved without auto-approval: %d %v", code, m)
	}
	if msg := h.notes.last(t, testUUID, 1); strings.Contains(msg, "Not approved automatically") {
		t.Fatalf("no reason is given when auto-approval is off:\n%s", msg)
	}
	if code, _, _ := h.do(h.public, getConfig("", configQuery(testUUID))); code != http.StatusUnauthorized {
		t.Fatal("a config without a token")
	}
}

func TestAttestClient(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/verdict/" + testSerial:
			_, _ = w.Write([]byte(`{"status":"attested","attested_at":"2026-10-29T01:00:00Z","node":"riptide","uuid":"` + testUUID + `"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := &AttestClient{BaseURL: srv.URL, Client: srv.Client()}
	v, err := c.Verdict(context.Background(), testSerial)
	if err != nil || v.Status != "attested" || v.Node != "riptide" || v.UUID != testUUID || v.AttestedAt.IsZero() {
		t.Fatalf("verdict: %+v %v", v, err)
	}
	if v, err := c.Verdict(context.Background(), "nobody"); err != nil || v.Status != "unknown" {
		t.Fatalf("a 404 is unknown: %+v %v", v, err)
	}
}
