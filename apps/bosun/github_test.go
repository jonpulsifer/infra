package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

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

	c := &ghClient{httpClient: server.Client(), token: "test-token", base: server.URL}
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

	c := &ghClient{httpClient: server.Client(), token: "t", base: server.URL}
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

	c := &ghClient{httpClient: server.Client(), token: "t", base: server.URL}
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

	c := &ghClient{httpClient: server.Client(), token: "t", base: server.URL}
	if _, _, err := c.GetRunner(context.Background(), "acme/widgets", 1); err == nil {
		t.Fatal("expected error on 403")
	}
}
