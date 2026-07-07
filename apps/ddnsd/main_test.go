package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cloudflare/cloudflare-go/v7"
	"github.com/cloudflare/cloudflare-go/v7/option"
)

// fakeCloudflare is a minimal stand-in for the Cloudflare v4 REST API,
// covering the zone lookup and DNS record endpoints ddnsd uses.
type fakeCloudflare struct {
	zoneID   string
	zoneName string
	// existing A records returned by the list endpoint, keyed by record ID
	records map[string]fakeRecord

	updates []fakeRecord // bodies of PUT (update) requests received
	creates []fakeRecord // bodies of POST (create) requests received
}

type fakeRecord struct {
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	Proxied bool   `json:"proxied"`
}

func envelope(result any) map[string]any {
	return map[string]any{
		"success":  true,
		"errors":   []any{},
		"messages": []any{},
		"result":   result,
		"result_info": map[string]any{
			"page": 1, "per_page": 100, "count": 1, "total_count": 1,
		},
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func (f *fakeCloudflare) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /zones", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, envelope([]map[string]any{
			{"id": f.zoneID, "name": f.zoneName},
		}))
	})
	mux.HandleFunc(fmt.Sprintf("GET /zones/%s/dns_records", f.zoneID), func(w http.ResponseWriter, r *http.Request) {
		records := make([]fakeRecord, 0, len(f.records))
		for id, rec := range f.records {
			rec.ID = id
			records = append(records, rec)
		}
		writeJSON(w, envelope(records))
	})
	mux.HandleFunc(fmt.Sprintf("PUT /zones/%s/dns_records/{id}", f.zoneID), func(w http.ResponseWriter, r *http.Request) {
		var rec fakeRecord
		decodeBody(t, r.Body, &rec)
		rec.ID = r.PathValue("id")
		f.updates = append(f.updates, rec)
		writeJSON(w, envelope(rec))
	})
	mux.HandleFunc(fmt.Sprintf("POST /zones/%s/dns_records", f.zoneID), func(w http.ResponseWriter, r *http.Request) {
		var rec fakeRecord
		decodeBody(t, r.Body, &rec)
		rec.ID = "new-record-id"
		f.creates = append(f.creates, rec)
		writeJSON(w, envelope(rec))
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		http.NotFound(w, r)
	})
	return mux
}

func decodeBody(t *testing.T, body io.Reader, v any) {
	t.Helper()
	if err := json.NewDecoder(body).Decode(v); err != nil {
		t.Fatalf("decoding request body: %v", err)
	}
}

func newTestClient(t *testing.T, fake *fakeCloudflare) *cloudflare.Client {
	t.Helper()
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	return cloudflare.NewClient(
		option.WithBaseURL(server.URL),
		option.WithAPIToken("test-token"),
		option.WithMaxRetries(0),
	)
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestUpdateNoChanges(t *testing.T) {
	fake := &fakeCloudflare{
		zoneID:   "zone-123",
		zoneName: "example.com",
		records: map[string]fakeRecord{
			"rec-1": {Type: "A", Name: "host.example.com", Content: "192.0.2.1", Proxied: false},
		},
	}
	api := newTestClient(t, fake)

	if err := update(context.Background(), api, "192.0.2.1", "host", "example.com", false, testLogger()); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(fake.updates) != 0 || len(fake.creates) != 0 {
		t.Errorf("expected no writes, got %d updates and %d creates", len(fake.updates), len(fake.creates))
	}
}

func TestUpdateExistingRecord(t *testing.T) {
	fake := &fakeCloudflare{
		zoneID:   "zone-123",
		zoneName: "example.com",
		records: map[string]fakeRecord{
			"rec-1": {Type: "A", Name: "host.example.com", Content: "192.0.2.1", Proxied: false},
		},
	}
	api := newTestClient(t, fake)

	if err := update(context.Background(), api, "198.51.100.7", "host", "example.com", false, testLogger()); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(fake.creates) != 0 {
		t.Fatalf("expected no creates, got %d", len(fake.creates))
	}
	if len(fake.updates) != 1 {
		t.Fatalf("expected 1 update, got %d", len(fake.updates))
	}
	got := fake.updates[0]
	if got.ID != "rec-1" {
		t.Errorf("updated wrong record: %s", got.ID)
	}
	if got.Type != "A" || got.Name != "host" || got.Content != "198.51.100.7" || got.Proxied {
		t.Errorf("unexpected update body: %+v", got)
	}
}

func TestUpdateProxiedChange(t *testing.T) {
	fake := &fakeCloudflare{
		zoneID:   "zone-123",
		zoneName: "example.com",
		records: map[string]fakeRecord{
			"rec-1": {Type: "A", Name: "host.example.com", Content: "192.0.2.1", Proxied: false},
		},
	}
	api := newTestClient(t, fake)

	// same IP but proxied flipped on: should still update
	if err := update(context.Background(), api, "192.0.2.1", "host", "example.com", true, testLogger()); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(fake.updates) != 1 {
		t.Fatalf("expected 1 update, got %d", len(fake.updates))
	}
	if !fake.updates[0].Proxied {
		t.Errorf("expected proxied=true in update body: %+v", fake.updates[0])
	}
}

func TestUpdateCreatesMissingRecord(t *testing.T) {
	fake := &fakeCloudflare{
		zoneID:   "zone-123",
		zoneName: "example.com",
		records:  map[string]fakeRecord{},
	}
	api := newTestClient(t, fake)

	if err := update(context.Background(), api, "203.0.113.9", "host", "example.com", false, testLogger()); err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(fake.updates) != 0 {
		t.Fatalf("expected no updates, got %d", len(fake.updates))
	}
	if len(fake.creates) != 1 {
		t.Fatalf("expected 1 create, got %d", len(fake.creates))
	}
	got := fake.creates[0]
	if got.Type != "A" || got.Name != "host" || got.Content != "203.0.113.9" || got.Proxied {
		t.Errorf("unexpected create body: %+v", got)
	}
}

func TestUpdateZoneNameMismatch(t *testing.T) {
	fake := &fakeCloudflare{
		zoneID:   "zone-123",
		zoneName: "other.com",
	}
	api := newTestClient(t, fake)

	err := update(context.Background(), api, "192.0.2.1", "host", "example.com", false, testLogger())
	if err == nil || !strings.Contains(err.Error(), "zone name mismatch") {
		t.Fatalf("expected zone name mismatch error, got %v", err)
	}
}

func TestDefaultInterval(t *testing.T) {
	t.Setenv("DDNSD_INTERVAL", "")
	if got := defaultInterval(); got != 5*time.Minute {
		t.Errorf("default: got %v, want 5m", got)
	}

	t.Setenv("DDNSD_INTERVAL", "30s")
	if got := defaultInterval(); got != 30*time.Second {
		t.Errorf("DDNSD_INTERVAL=30s: got %v, want 30s", got)
	}
}
