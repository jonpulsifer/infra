package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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

// newTestUpdater builds an updater against the fake, exercising the zone
// lookup that construction performs.
func newTestUpdater(t *testing.T, fake *fakeCloudflare, name string, proxied bool) *updater {
	t.Helper()
	cfg := config{
		zone:    fake.zoneName,
		fqdn:    recordName(name, fake.zoneName),
		proxied: proxied,
	}
	u, err := newUpdater(context.Background(), newTestClient(t, fake), cfg, testLogger())
	if err != nil {
		t.Fatalf("newUpdater: %v", err)
	}
	return u
}

func hostFake() *fakeCloudflare {
	return &fakeCloudflare{
		zoneID:   "zone-123",
		zoneName: "example.com",
		records: map[string]fakeRecord{
			"rec-1": {Type: "A", Name: "host.example.com", Content: "192.0.2.1", Proxied: false},
		},
	}
}

func TestReconcileNoChanges(t *testing.T) {
	fake := hostFake()
	u := newTestUpdater(t, fake, "host", false)

	if err := u.reconcile(context.Background(), "192.0.2.1", testLogger()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(fake.updates) != 0 || len(fake.creates) != 0 {
		t.Errorf("expected no writes, got %d updates and %d creates", len(fake.updates), len(fake.creates))
	}
}

func TestReconcileExistingRecord(t *testing.T) {
	fake := hostFake()
	u := newTestUpdater(t, fake, "host", false)

	if err := u.reconcile(context.Background(), "198.51.100.7", testLogger()); err != nil {
		t.Fatalf("reconcile: %v", err)
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
	if got.Type != "A" || got.Name != "host.example.com" || got.Content != "198.51.100.7" || got.Proxied {
		t.Errorf("unexpected update body: %+v", got)
	}
}

func TestReconcileProxiedChange(t *testing.T) {
	fake := hostFake()
	u := newTestUpdater(t, fake, "host", true)

	// same IP but proxied flipped on: should still update
	if err := u.reconcile(context.Background(), "192.0.2.1", testLogger()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(fake.updates) != 1 {
		t.Fatalf("expected 1 update, got %d", len(fake.updates))
	}
	if !fake.updates[0].Proxied {
		t.Errorf("expected proxied=true in update body: %+v", fake.updates[0])
	}
}

func TestReconcileCreatesMissingRecord(t *testing.T) {
	fake := hostFake()
	fake.records = map[string]fakeRecord{}
	u := newTestUpdater(t, fake, "host", false)

	if err := u.reconcile(context.Background(), "203.0.113.9", testLogger()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(fake.updates) != 0 {
		t.Fatalf("expected no updates, got %d", len(fake.updates))
	}
	if len(fake.creates) != 1 {
		t.Fatalf("expected 1 create, got %d", len(fake.creates))
	}
	got := fake.creates[0]
	if got.Type != "A" || got.Name != "host.example.com" || got.Content != "203.0.113.9" || got.Proxied {
		t.Errorf("unexpected create body: %+v", got)
	}
}

// TestReconcileApexMatchesExistingRecord pins the apex fix: the zone apex
// record is named after the zone, so "@" must resolve to "example.com". Asking
// for "@.example.com" matched nothing and created a duplicate on every pass.
func TestReconcileApexMatchesExistingRecord(t *testing.T) {
	fake := hostFake()
	fake.records = map[string]fakeRecord{
		"apex-1": {Type: "A", Name: "example.com", Content: "192.0.2.1", Proxied: false},
	}
	u := newTestUpdater(t, fake, "@", false)

	if err := u.reconcile(context.Background(), "198.51.100.7", testLogger()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(fake.creates) != 0 {
		t.Fatalf("apex reconcile created a duplicate record: %+v", fake.creates)
	}
	if len(fake.updates) != 1 || fake.updates[0].ID != "apex-1" {
		t.Fatalf("expected the apex record to be updated, got %+v", fake.updates)
	}
}

func TestNewUpdaterZoneNameMismatch(t *testing.T) {
	fake := &fakeCloudflare{zoneID: "zone-123", zoneName: "other.com"}
	cfg := config{zone: "example.com", fqdn: "host.example.com"}

	_, err := newUpdater(context.Background(), newTestClient(t, fake), cfg, testLogger())
	if err == nil || !strings.Contains(err.Error(), "zone name mismatch") {
		t.Fatalf("expected zone name mismatch error, got %v", err)
	}
}

// TestRefreshReResolves pins the contract that makes ddnsd dynamic: every pass
// looks the address up again. Reading it once and reusing the value leaves the
// record pointing at the previous lease forever.
func TestRefreshReResolves(t *testing.T) {
	fake := hostFake()
	u := newTestUpdater(t, fake, "host", false)

	addresses := []string{"192.0.2.1", "198.51.100.7"}
	resolved := 0
	u.resolve = func(context.Context) (string, error) {
		ip := addresses[resolved]
		resolved++
		return ip, nil
	}

	for range addresses {
		if err := u.Refresh(context.Background()); err != nil {
			t.Fatalf("refresh: %v", err)
		}
	}

	if resolved != len(addresses) {
		t.Errorf("resolved %d times, want %d", resolved, len(addresses))
	}
	// First pass matches the existing record and writes nothing; the second
	// sees a new address and must push it.
	if len(fake.updates) != 1 {
		t.Fatalf("expected 1 update, got %d", len(fake.updates))
	}
	if got := fake.updates[0].Content; got != "198.51.100.7" {
		t.Errorf("updated to %q, want the freshly resolved address", got)
	}
}

// TestNewUpdaterResolvesZoneOnce pins that the zone lookup is construction-time
// work, not per-pass work.
func TestNewUpdaterResolvesZoneOnce(t *testing.T) {
	fake := hostFake()
	lookups := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/zones" {
			lookups++
		}
		fake.handler(t).ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)

	api := cloudflare.NewClient(
		option.WithBaseURL(server.URL),
		option.WithAPIToken("test-token"),
		option.WithMaxRetries(0),
	)
	cfg := config{zone: "example.com", fqdn: "host.example.com"}
	u, err := newUpdater(context.Background(), api, cfg, testLogger())
	if err != nil {
		t.Fatalf("newUpdater: %v", err)
	}
	u.resolve = func(context.Context) (string, error) { return "192.0.2.1", nil }

	for range 3 {
		if err := u.Refresh(context.Background()); err != nil {
			t.Fatalf("refresh: %v", err)
		}
	}

	if lookups != 1 {
		t.Errorf("zone was looked up %d times, want 1", lookups)
	}
}

func TestRecordName(t *testing.T) {
	for _, tc := range []struct{ name, zone, want string }{
		{"host", "example.com", "host.example.com"},
		{"@", "example.com", "example.com"},
		{"", "example.com", "example.com"},
		{"example.com", "example.com", "example.com"},
		{"host.example.com", "example.com", "host.example.com"},
		{"HOST", "Example.com", "host.example.com"},
		{"host.", "example.com.", "host.example.com"},
		{" host ", "example.com", "host.example.com"},
		{"a.b", "example.com", "a.b.example.com"},
	} {
		if got := recordName(tc.name, tc.zone); got != tc.want {
			t.Errorf("recordName(%q, %q) = %q, want %q", tc.name, tc.zone, got, tc.want)
		}
	}
}

func env(kv map[string]string) func(string) string {
	return func(k string) string { return kv[k] }
}

func TestParseConfigDefaults(t *testing.T) {
	cfg, err := parseConfig(nil, env(map[string]string{
		"CLOUDFLARE_DNS_ZONE":  "example.com",
		"CLOUDFLARE_DNS_NAME":  "host",
		"CLOUDFLARE_API_TOKEN": "tok",
	}))
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.fqdn != "host.example.com" || cfg.zone != "example.com" || cfg.token != "tok" {
		t.Errorf("unexpected config: %+v", cfg)
	}
	if cfg.interval != 5*time.Minute {
		t.Errorf("interval = %v, want 5m", cfg.interval)
	}
	if cfg.once || cfg.proxied {
		t.Errorf("expected once and proxied to default false: %+v", cfg)
	}
}

func TestParseConfigFlagsBeatEnv(t *testing.T) {
	cfg, err := parseConfig(
		[]string{"-zone", "other.com", "-name", "@", "-token", "flagtok", "-interval", "90s", "-proxied", "-once"},
		env(map[string]string{
			"CLOUDFLARE_DNS_ZONE":  "example.com",
			"CLOUDFLARE_DNS_NAME":  "host",
			"CLOUDFLARE_API_TOKEN": "envtok",
			"DDNSD_INTERVAL":       "1h",
		}),
	)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.zone != "other.com" || cfg.fqdn != "other.com" || cfg.token != "flagtok" {
		t.Errorf("unexpected config: %+v", cfg)
	}
	if cfg.interval != 90*time.Second {
		t.Errorf("interval = %v, want 90s", cfg.interval)
	}
	if !cfg.proxied || !cfg.once {
		t.Errorf("expected proxied and once set: %+v", cfg)
	}
}

func TestParseConfigIntervalFromEnv(t *testing.T) {
	cfg, err := parseConfig(nil, env(map[string]string{
		"CLOUDFLARE_DNS_ZONE":  "example.com",
		"CLOUDFLARE_DNS_NAME":  "host",
		"CLOUDFLARE_API_TOKEN": "tok",
		"DDNSD_INTERVAL":       "30s",
	}))
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.interval != 30*time.Second {
		t.Errorf("interval = %v, want 30s", cfg.interval)
	}
}

func TestParseConfigTokenFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "token")
	if err := os.WriteFile(path, []byte("  filetok\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := parseConfig(
		[]string{"-zone", "example.com", "-name", "host", "-token-file", path},
		env(nil),
	)
	if err != nil {
		t.Fatalf("parseConfig: %v", err)
	}
	if cfg.token != "filetok" {
		t.Errorf("token = %q, want %q", cfg.token, "filetok")
	}
}

func TestParseConfigErrors(t *testing.T) {
	dir := t.TempDir()
	blank := filepath.Join(dir, "blank")
	if err := os.WriteFile(blank, []byte("   \n"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		desc string
		args []string
		env  map[string]string
		want string
	}{
		{"no zone", []string{"-token", "tok"}, nil, "zone is required"},
		{"no token", []string{"-zone", "example.com"}, nil, "token is required"},
		{"missing token file", []string{"-zone", "example.com", "-token-file", filepath.Join(dir, "nope")}, nil, "reading token file"},
		{"blank token file", []string{"-zone", "example.com", "-token-file", blank}, nil, "token file is empty"},
		{"bad env interval", []string{"-zone", "example.com", "-token", "t"}, map[string]string{"DDNSD_INTERVAL": "banana"}, "DDNSD_INTERVAL"},
		{"zero interval", []string{"-zone", "example.com", "-token", "t", "-interval", "0"}, nil, "interval must be positive"},
	} {
		t.Run(tc.desc, func(t *testing.T) {
			_, err := parseConfig(tc.args, env(tc.env))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want an error containing %q", err, tc.want)
			}
		})
	}
}
