package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// fakeSpindrift is an in-memory stand-in for the three bosun-facing
// endpoints Spindrift exposes.
type fakeSpindrift struct {
	mu sync.Mutex

	claims       []*buildClaim // popped front-to-back by ClaimBuild
	claimErr     error
	heartbeats   []string
	heartbeatErr error
	results      []postedResult
	resultErr    error
}

type postedResult struct {
	id  string
	res buildResult
}

func (f *fakeSpindrift) ClaimBuild(ctx context.Context, classes []string) (*buildClaim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claimErr != nil {
		return nil, f.claimErr
	}
	if len(f.claims) == 0 {
		return nil, nil
	}
	c := f.claims[0]
	f.claims = f.claims[1:]
	return c, nil
}

func (f *fakeSpindrift) Heartbeat(ctx context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heartbeats = append(f.heartbeats, id)
	return f.heartbeatErr
}

func (f *fakeSpindrift) PostResult(ctx context.Context, id string, res buildResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resultErr != nil {
		return f.resultErr
	}
	f.results = append(f.results, postedResult{id: id, res: res})
	return nil
}

func (f *fakeSpindrift) postedResults() []postedResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]postedResult(nil), f.results...)
}

func TestSDClientClaimBuildDecodes200(t *testing.T) {
	var gotBody map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/claim", func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "Bearer test-token" {
			t.Errorf("unexpected auth header: %s", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		json.NewEncoder(w).Encode(map[string]any{
			"id":      "build-1",
			"class":   "skiff-build",
			"request": map[string]any{"repo": "acme/widgets"},
		})
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "test-token", base: server.URL}
	claim, err := c.ClaimBuild(context.Background(), []string{"skiff-build"})
	if err != nil {
		t.Fatalf("ClaimBuild: %v", err)
	}
	if claim == nil || claim.ID != "build-1" || claim.Class != "skiff-build" {
		t.Fatalf("unexpected claim: %+v", claim)
	}
	classes, _ := gotBody["classes"].([]any)
	if len(classes) != 1 || classes[0] != "skiff-build" {
		t.Fatalf("unexpected request body: %v", gotBody)
	}
}

func TestSDClientClaimBuildReturnsNilOn204(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/claim", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "t", base: server.URL}
	claim, err := c.ClaimBuild(context.Background(), []string{"skiff-build"})
	if err != nil {
		t.Fatalf("ClaimBuild: %v", err)
	}
	if claim != nil {
		t.Fatalf("want nil claim on 204, got %+v", claim)
	}
}

func TestSDClientClaimBuildErrorsOn500(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/claim", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "t", base: server.URL}
	if _, err := c.ClaimBuild(context.Background(), []string{"skiff-build"}); err == nil {
		t.Fatal("expected error on 500")
	}
}

func TestSDClientPostResultSendsBodyAndAuth(t *testing.T) {
	var gotBody map[string]any
	var gotAuth string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/requests/build-1/result", func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "test-token", base: server.URL}
	err := c.PostResult(context.Background(), "build-1", buildResult{Status: buildSucceeded, Log: "ok"})
	if err != nil {
		t.Fatalf("PostResult: %v", err)
	}
	if gotAuth != "Bearer test-token" {
		t.Fatalf("unexpected auth header: %s", gotAuth)
	}
	if gotBody["status"] != buildSucceeded || gotBody["log"] != "ok" {
		t.Fatalf("unexpected posted result: %v", gotBody)
	}
}

func TestSDClientHeartbeatPostsToTheRequestID(t *testing.T) {
	called := false
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/requests/build-1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "t", base: server.URL}
	if err := c.Heartbeat(context.Background(), "build-1"); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !called {
		t.Fatal("heartbeat endpoint was never called")
	}
}

func TestTailStringKeepsTheEndNotTheStart(t *testing.T) {
	body := []byte("0123456789")
	got := tailString(body, 4)
	if got != "6789" {
		t.Fatalf("got %q, want the last 4 bytes", got)
	}
	if got := tailString(body, 100); got != string(body) {
		t.Fatalf("short input should be returned unchanged, got %q", got)
	}
}
