package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fixedToken builds a ghClient token source that always returns s, ignoring
// ctx and repo -- what every test here wants except the one that exercises
// appAuth itself.
func fixedToken(s string) func(context.Context, string) (string, error) {
	return func(context.Context, string) (string, error) { return s, nil }
}

// fakeGitHub is an in-memory stand-in for the three runner endpoints bosun
// calls. It never simulates the list endpoint on purpose: bosun must never
// call it either.
type fakeGitHub struct {
	mu        sync.Mutex
	nextID    int64
	statuses  map[int64]fakeRunnerStatus
	deleted   []int64
	generated []fakeGenerated
	onDelete  func(runnerID int64) // observation hook for a successful delete; drain tests pin ordering with it
}

type fakeRunnerStatus struct {
	status string
	busy   bool
}

type fakeGenerated struct {
	repo, name string
	labels     []string
}

func newFakeGitHub() *fakeGitHub {
	return &fakeGitHub{statuses: map[int64]fakeRunnerStatus{}}
}

func (f *fakeGitHub) GenerateJITConfig(ctx context.Context, repo, name string, labels []string) (int64, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	id := f.nextID
	f.generated = append(f.generated, fakeGenerated{repo: repo, name: name, labels: labels})
	f.statuses[id] = fakeRunnerStatus{status: "offline", busy: false}
	return id, fmt.Sprintf("encoded-jit-%d", id), nil
}

func (f *fakeGitHub) GetRunner(ctx context.Context, repo string, runnerID int64) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.statuses[runnerID]
	if !ok {
		return "", false, fmt.Errorf("unknown runner %d", runnerID)
	}
	return s.status, s.busy, nil
}

func (f *fakeGitHub) DeleteRunner(ctx context.Context, repo string, runnerID int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	// The real API refuses to delete a runner that is running a job (422),
	// and drain's whole safety argument rests on that refusal.
	if s, ok := f.statuses[runnerID]; ok && s.busy {
		return fmt.Errorf("fake: runner %d is busy", runnerID)
	}
	f.deleted = append(f.deleted, runnerID)
	delete(f.statuses, runnerID)
	if f.onDelete != nil {
		f.onDelete(runnerID)
	}
	return nil
}

func (f *fakeGitHub) deletedIDs() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]int64(nil), f.deleted...)
}

func (f *fakeGitHub) setStatus(runnerID int64, status string, busy bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[runnerID] = fakeRunnerStatus{status: status, busy: busy}
}

func TestGHClientGenerateJITConfig(t *testing.T) {
	var gotBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("POST /repos/acme/widgets/actions/runners/generate-jitconfig", func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-token" {
			t.Errorf("unexpected auth header: %s", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]any{
			"runner":             map[string]any{"id": 99},
			"encoded_jit_config": "encoded-abc",
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &ghClient{httpClient: server.Client(), token: fixedToken("test-token"), base: server.URL}
	id, jit, err := c.GenerateJITConfig(context.Background(), "acme/widgets", "skiff-01", []string{"skiff-nixos"})
	if err != nil {
		t.Fatalf("GenerateJITConfig: %v", err)
	}
	if id != 99 || jit != "encoded-abc" {
		t.Fatalf("got id=%d jit=%s", id, jit)
	}
	if gotBody["name"] != "skiff-01" || gotBody["runner_group_id"] != float64(1) {
		t.Fatalf("unexpected request body: %v", gotBody)
	}
	labels, _ := gotBody["labels"].([]any)
	if len(labels) != 1 || labels[0] != "skiff-nixos" {
		t.Fatalf("unexpected labels: %v", gotBody["labels"])
	}
}

func TestGHClientGetRunner(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/acme/widgets/actions/runners/7", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"status": "online", "busy": true})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &ghClient{httpClient: server.Client(), token: fixedToken("t"), base: server.URL}
	status, busy, err := c.GetRunner(context.Background(), "acme/widgets", 7)
	if err != nil {
		t.Fatalf("GetRunner: %v", err)
	}
	if status != "online" || !busy {
		t.Fatalf("got status=%s busy=%v", status, busy)
	}
}

func TestGHClientDeleteRunner(t *testing.T) {
	deleted := false
	mux := http.NewServeMux()
	mux.HandleFunc("DELETE /repos/acme/widgets/actions/runners/7", func(w http.ResponseWriter, r *http.Request) {
		deleted = true
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &ghClient{httpClient: server.Client(), token: fixedToken("t"), base: server.URL}
	if err := c.DeleteRunner(context.Background(), "acme/widgets", 7); err != nil {
		t.Fatalf("DeleteRunner: %v", err)
	}
	if !deleted {
		t.Fatal("DELETE was not called")
	}
}

func TestGHClientErrorStatus(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"nope"}`, http.StatusForbidden)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &ghClient{httpClient: server.Client(), token: fixedToken("t"), base: server.URL}
	if _, _, err := c.GetRunner(context.Background(), "acme/widgets", 1); err == nil {
		t.Fatal("expected error on 403")
	}
}

// TestAppAuthTokenMintsCachesAndRefreshes exercises the JWT-mint-and-cache
// core of appAuth against a throwaway RSA key and a fake App API: first call
// resolves the installation and mints a token; a call still inside the
// token's lifetime reuses it with no further HTTP calls; a call inside the
// refresh margin mints again but does not re-resolve the installation.
func TestAppAuthTokenMintsCachesAndRefreshes(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	keyPath := filepath.Join(t.TempDir(), "app-key.pem")
	pemBytes := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(keyPath, pemBytes, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	var (
		mu          sync.Mutex
		resolveHits int
		mintHits    int
		lastAuth    string
	)
	current := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /repos/acme/widgets/installation", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		resolveHits++
		lastAuth = r.Header.Get("Authorization")
		mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"id": 42})
	})
	mux.HandleFunc("POST /app/installations/42/access_tokens", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		mintHits++
		n := mintHits
		mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{
			"token":      fmt.Sprintf("inst-token-%d", n),
			"expires_at": current.Add(time.Hour).Format(time.RFC3339),
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	auth, err := newAppAuth(12345, keyPath)
	if err != nil {
		t.Fatalf("newAppAuth: %v", err)
	}
	auth.httpClient = server.Client()
	auth.base = server.URL
	auth.now = func() time.Time { return current }

	ctx := context.Background()
	tok, err := auth.Token(ctx, "acme/widgets")
	if err != nil {
		t.Fatalf("Token: %v", err)
	}
	if tok != "inst-token-1" {
		t.Fatalf("got token %q", tok)
	}
	if resolveHits != 1 || mintHits != 1 {
		t.Fatalf("first call: resolveHits=%d mintHits=%d", resolveHits, mintHits)
	}
	if !strings.HasPrefix(lastAuth, "Bearer ") || strings.Count(lastAuth, ".") != 2 {
		t.Fatalf("installation lookup wasn't authorized with a 3-part JWT: %q", lastAuth)
	}

	// Still inside the cached token's lifetime: reused, no new HTTP calls.
	tok2, err := auth.Token(ctx, "acme/widgets")
	if err != nil {
		t.Fatalf("Token (cached): %v", err)
	}
	if tok2 != tok || resolveHits != 1 || mintHits != 1 {
		t.Fatalf("expected a cache hit, got token=%q resolveHits=%d mintHits=%d", tok2, resolveHits, mintHits)
	}

	// Inside the refresh margin of the cached token's expiry: mints again,
	// but the installation id -- resolved once above -- stays cached.
	current = current.Add(56 * time.Minute)
	tok3, err := auth.Token(ctx, "acme/widgets")
	if err != nil {
		t.Fatalf("Token (refresh): %v", err)
	}
	if tok3 != "inst-token-2" || resolveHits != 1 || mintHits != 2 {
		t.Fatalf("expected a refreshed mint, got token=%q resolveHits=%d mintHits=%d", tok3, resolveHits, mintHits)
	}
}
