package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// netboxFake answers the routes the directory uses for one device, riptide,
// whose status and attest_consumed_at a test can set.
type netboxFake struct {
	mu       sync.Mutex
	status   string
	consumed any
	writes   []map[string]any
	journal  int
	journal5 bool // make the journal route answer 500
}

func (nb *netboxFake) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/dcim/devices/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer nbt_test" {
			http.Error(w, "forbidden", 403)
			return
		}
		q := r.URL.Query()
		if q.Get("role") != "kubernetes-node" || q.Get("site") != "folly" {
			t.Errorf("query lacks role and site: %s", r.URL.RawQuery)
		}
		nb.mu.Lock()
		device := map[string]any{
			"id": 7, "name": "riptide", "serial": "MXL0172Q6L",
			"status":      map[string]any{"value": nb.status},
			"primary_ip4": map[string]any{"address": "10.3.0.12/26"},
			"custom_fields": map[string]any{
				"talos_class": "worker-g5", "install_disk": "/dev/nvme0n1", "tpm_version": "2.0",
				"attest_verdict": "attested", "last_attested": "2026-10-29T01:00:00Z", "attest_consumed_at": nb.consumed,
			},
		}
		nb.mu.Unlock()
		results := []any{}
		if s := q.Get("serial"); s == "" || strings.EqualFold(s, "MXL0172Q6L") {
			if n := q.Get("name"); n == "" || n == "riptide" {
				results = append(results, device)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"count": len(results), "results": results})
	})
	mux.HandleFunc("GET /api/dcim/interfaces/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("device_id") != "7" {
			http.Error(w, "unexpected device", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"results": []any{
			map[string]any{"id": 12, "primary_mac_address": nil},
			map[string]any{"id": 11, "primary_mac_address": map[string]any{"mac_address": "38:22:E2:2D:96:44"}},
		}})
	})
	mux.HandleFunc("PATCH /api/dcim/devices/{id}/", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		body["_path"] = r.Method + " " + r.URL.Path
		nb.mu.Lock()
		nb.writes = append(nb.writes, body)
		nb.mu.Unlock()
		_, _ = io.WriteString(w, "{}")
	})
	mux.HandleFunc("POST /api/extras/journal-entries/", func(w http.ResponseWriter, r *http.Request) {
		nb.mu.Lock()
		defer nb.mu.Unlock()
		if nb.journal5 {
			http.Error(w, "boom", 500)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		body["_path"] = r.Method + " " + r.URL.Path
		nb.writes = append(nb.writes, body)
		nb.journal++
		_, _ = io.WriteString(w, "{}")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func (nb *netboxFake) written() []map[string]any {
	nb.mu.Lock()
	defer nb.mu.Unlock()
	return append([]map[string]any{}, nb.writes...)
}

func TestNetBoxDirectory(t *testing.T) {
	fake := &netboxFake{status: "staged"}
	srv := fake.server(t)
	nb := &NetBox{URL: srv.URL, Token: "nbt_test", Site: "folly", Client: srv.Client(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()

	n, err := nb.BySerial(ctx, "mxl0172q6l")
	if err != nil {
		t.Fatal(err)
	}
	want := Node{Name: "riptide", Serial: "MXL0172Q6L", MAC: "38:22:e2:2d:96:44", Class: "worker-g5", Address: "10.3.0.12",
		Disk: "/dev/nvme0n1", TPM: "2.0", Status: "staged", Verdict: "attested", Source: "netbox", ID: 7,
		LastAttested: time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)}
	if n != want {
		t.Fatalf("by serial:\n got %+v\nwant %+v", n, want)
	}
	if ok, why := n.Attested(); !ok {
		t.Fatalf("a staged device with a fresh pass: %s", why)
	}
	if _, err := nb.BySerial(ctx, "OTHER"); !errors.Is(err, ErrUnknownNode) {
		t.Fatalf("unknown serial: %v", err)
	}
	if m, err := nb.ByName(ctx, "riptide"); err != nil || m.ID != 7 {
		t.Fatalf("by name: %+v %v", m, err)
	}
	if names, err := nb.Names(ctx); err != nil || len(names) != 1 || names[0] != "riptide" {
		t.Fatalf("names: %v %v", names, err)
	}

	at := time.Date(2026, 10, 29, 1, 5, 0, 0, time.UTC)
	if err := nb.Spend(ctx, n, at); err != nil {
		t.Fatal(err)
	}
	w := fake.written()
	if len(w) != 1 || w[0]["_path"] != "PATCH /api/dcim/devices/7/" || w[0]["status"] != nil {
		t.Fatalf("a spend patches only the custom field: %v", w)
	}
	if cf := w[0]["custom_fields"].(map[string]any); cf["attest_consumed_at"] != "2026-10-29T01:05:00Z" {
		t.Fatalf("the spend must write attest_consumed_at: %v", cf)
	}

	rel := time.Date(2026, 10, 29, 1, 6, 0, 0, time.UTC)
	if err := nb.Released(ctx, n, rel); err != nil {
		t.Fatal(err)
	}
	w = fake.written()
	if len(w) != 3 || w[1]["_path"] != "PATCH /api/dcim/devices/7/" || w[1]["status"] != "active" {
		t.Fatalf("the release must patch a staged device active: %v", w)
	}
	if cf := w[1]["custom_fields"].(map[string]any); cf["attest_consumed_at"] != "2026-10-29T01:06:00Z" {
		t.Fatalf("the release must spend at its own time: %v", cf)
	}
	if w[2]["_path"] != "POST /api/extras/journal-entries/" || !strings.Contains(w[2]["comments"].(string), "released to riptide") {
		t.Fatalf("the release must leave a journal entry: %v", w[2])
	}

	bad := &NetBox{URL: srv.URL, Token: "wrong", Site: "folly", Client: srv.Client()}
	if _, err := bad.BySerial(ctx, "MXL0172Q6L"); err == nil || errors.Is(err, ErrUnknownNode) {
		t.Fatalf("a refused token must be a failure, not an unknown node: %v", err)
	}
}

func TestNetBoxReleaseNeverResurrectsAndJournalFailureIsNotAFailure(t *testing.T) {
	fake := &netboxFake{status: "failed", journal5: true}
	srv := fake.server(t)
	nb := &NetBox{URL: srv.URL, Token: "nbt_test", Site: "folly", Client: srv.Client(), Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()
	n, err := nb.ByName(ctx, "riptide")
	if err != nil {
		t.Fatal(err)
	}
	if err := nb.Released(ctx, n, time.Now()); err != nil {
		t.Fatalf("a journal failure after the patch is logged, not returned: %v", err)
	}
	w := fake.written()
	if len(w) != 1 || w[0]["status"] != nil {
		t.Fatalf("a failed device must keep its status on release: %v", w)
	}

	for _, status := range []string{"decommissioning", "offline"} {
		fake.mu.Lock()
		fake.status = status
		fake.mu.Unlock()
		if _, err := nb.ByName(ctx, "riptide"); !errors.Is(err, ErrRetired) {
			t.Fatalf("%s must be refused by name: %v", status, err)
		}
	}
}

func TestNetBoxUnreadableConsumedTimeCountsAsSpent(t *testing.T) {
	fake := &netboxFake{status: "staged", consumed: "yesterday"}
	srv := fake.server(t)
	nb := &NetBox{URL: srv.URL, Token: "nbt_test", Site: "folly", Client: srv.Client()}
	n, err := nb.BySerial(context.Background(), "MXL0172Q6L")
	if err != nil {
		t.Fatal(err)
	}
	if !n.ConsumedUnknown {
		t.Fatal("an unreadable attest_consumed_at must be flagged")
	}
	if ok, why := n.Attested(); ok || !strings.Contains(why, "counts as spent") {
		t.Fatalf("an unreadable consumed time must fail closed: %v %s", ok, why)
	}
}

func TestFallbackAnswersFromTheInventoryWhenNetBoxFails(t *testing.T) {
	primary := newFakeDirectory()
	primary.fail = errors.New("connection refused")
	secondary := newFakeDirectory()
	secondary.set("riptide", func(n *Node) { n.Class = "from-inventory" })
	f := &Fallback{Primary: primary, Secondary: secondary, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	ctx := context.Background()

	if n, err := f.BySerial(ctx, testSerial); err != nil || n.Class != "from-inventory" {
		t.Fatalf("during the outage: %+v %v", n, err)
	}
	primary.fail = nil
	if n, err := f.BySerial(ctx, testSerial); err != nil || n.Class != "worker-g5" {
		t.Fatalf("after the outage: %+v %v", n, err)
	}
	if _, err := f.BySerial(ctx, "nobody"); !errors.Is(err, ErrUnknownNode) {
		t.Fatalf("an unknown serial in NetBox is an answer, not a fallback: %v", err)
	}
	now := time.Now()
	if err := f.Spend(ctx, Node{Name: "riptide"}, now); err != nil || len(primary.spent()) != 1 || len(secondary.spent()) != 0 {
		t.Fatal("a spend goes to NetBox only")
	}
	if err := f.Released(ctx, Node{Name: "riptide"}, now); err != nil || len(primary.released()) != 1 || len(secondary.released()) != 0 {
		t.Fatal("a release goes to NetBox only")
	}
	if err := (&Inventory{}).Spend(ctx, Node{}, now); err == nil {
		t.Fatal("the inventory must refuse to spend")
	}
}
