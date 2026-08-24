package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeSpindrift is an in-memory stand-in for the three bosun-facing
// endpoints Spindrift exposes.
type fakeSpindrift struct {
	mu sync.Mutex

	claims       []*buildClaim // popped front-to-back by ClaimBuild
	claimErr     error
	heartbeats   []string
	claimants    []string
	heartbeatErr error
	results      []postedResult
	resultErr    error
}

type postedResult struct {
	id       string
	claimant string
	res      buildResult
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

func (f *fakeSpindrift) Heartbeat(ctx context.Context, id, claimant string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.heartbeats = append(f.heartbeats, id)
	f.claimants = append(f.claimants, claimant)
	return f.heartbeatErr
}

func (f *fakeSpindrift) PostResult(ctx context.Context, id, claimant string, res buildResult) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resultErr != nil {
		return f.resultErr
	}
	f.results = append(f.results, postedResult{id: id, claimant: claimant, res: res})
	return nil
}

func (f *fakeSpindrift) postedResults() []postedResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]postedResult(nil), f.results...)
}

// poolBuildSource is the production wiring: a buildSource whose spawns land in
// a real warm pool, for the tests that assert on what the pool did with them.
func poolBuildSource(p *pool, sd spindriftClient) *buildSource {
	return &buildSource{
		sd: sd,
		spawn: func(ctx context.Context, claim *buildClaim) (*skiff, error) {
			return p.spawn(ctx, p.buildBerth(claim))
		},
		logger: p.logger,
		stats:  p.stats,
	}
}

// The claim/result choreography with no warm pool behind it at all: the port
// hands back a skiff, the build waits for it to be gone, and the result comes
// from the diag share the guest wrote.
func TestBuildSourcePostsTheResultTheGuestLeftBehind(t *testing.T) {
	diagDir := t.TempDir()
	resultDir := filepath.Join(diagDir, "result")
	if err := os.MkdirAll(resultDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(resultDir, "status"), "SUCCEEDED")
	writeFile(t, filepath.Join(resultDir, "build.log"), "build ok\n")

	s := &skiff{paths: skiffPaths{diagDir: diagDir}, done: make(chan struct{})}
	sd := &fakeSpindrift{}
	b := &buildSource{
		sd:     sd,
		spawn:  func(context.Context, *buildClaim) (*skiff, error) { return s, nil },
		logger: testLogger(),
		stats:  newMetrics(),
	}

	done := make(chan struct{})
	go func() {
		b.runBuild(context.Background(), &buildClaim{ID: "build-1", Class: "skiff-test"})
		close(done)
	}()
	close(s.done) // the skiff is gone; its diag share is safe to read

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runBuild did not return after the skiff was gone")
	}

	results := sd.postedResults()
	if len(results) != 1 {
		t.Fatalf("want 1 posted result, got %d", len(results))
	}
	if results[0].id != "build-1" || results[0].res.Status != buildSucceeded || results[0].res.Log != "build ok\n" {
		t.Fatalf("unexpected posted result: %+v", results[0])
	}
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
	err := c.PostResult(context.Background(), "build-1", "", buildResult{Status: buildSucceeded, Log: "ok"})
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

// A 404 on the heartbeat is Spindrift saying the row is no longer this
// host's -- the one answer runBuild has to act on rather than log.
func TestSDClientHeartbeatReportsALostClaim(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/requests/build-1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"code":"NOT_FOUND"}`, http.StatusNotFound)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "t", base: server.URL}
	err := c.Heartbeat(context.Background(), "build-1", "claim-1")
	if !errors.Is(err, errClaimLost) {
		t.Fatalf("want errClaimLost, got %v", err)
	}
}

// Spindrift never dials in, so a cancel on its side reaches the skiff only
// as a refused heartbeat. The skiff is killed rather than left to finish and
// push, and nothing is posted for a row nobody would accept a result on.
func TestRunBuildKillsTheSkiffWhenTheClaimIsLost(t *testing.T) {
	ch := newFakeProc()
	s := &skiff{build: true, paths: skiffPaths{diagDir: t.TempDir()}, ch: ch, done: make(chan struct{})}
	sd := &fakeSpindrift{heartbeatErr: errClaimLost}
	b := &buildSource{
		sd:             sd,
		spawn:          func(context.Context, *buildClaim) (*skiff, error) { return s, nil },
		logger:         testLogger(),
		stats:          newMetrics(),
		heartbeatEvery: 5 * time.Millisecond,
	}

	done := make(chan struct{})
	go func() {
		b.runBuild(context.Background(), &buildClaim{ID: "build-1", Claimant: "claim-1"})
		close(done)
	}()

	// awaitExit's half of the choreography: the VMM exits under the kill, and
	// retire closes done once the skiff is gone.
	waited := make(chan error, 1)
	go func() { waited <- ch.Wait() }()
	select {
	case err := <-waited:
		if !errors.Is(err, errFakeKilled) {
			t.Fatalf("the skiff exited on its own rather than under the kill: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the skiff was not killed after the claim was lost")
	}
	close(s.done)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runBuild did not return after the skiff was gone")
	}
	if got := s.reason(); got != exitCancelled {
		t.Fatalf("exit reason: got %q, want %q", got, exitCancelled)
	}
	if got := sd.postedResults(); len(got) != 0 {
		t.Fatalf("a lost claim should post nothing, got %+v", got)
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
	if err := c.Heartbeat(context.Background(), "build-1", ""); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !called {
		t.Fatal("heartbeat endpoint was never called")
	}
}

// The fence's Go half: the claim's token rides on every later call, and an
// empty one -- what a Spindrift too old to mint claimants decodes to -- sends
// no parameter at all rather than an empty one the far side would have to
// special-case.
func TestSDClientCarriesTheClaimantWhenThereIsOne(t *testing.T) {
	var heartbeatQuery, resultQuery string
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/bosun/requests/build-1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		heartbeatQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /internal/bosun/requests/build-1/result", func(w http.ResponseWriter, r *http.Request) {
		resultQuery = r.URL.RawQuery
		w.WriteHeader(http.StatusNoContent)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	c := &sdClient{httpClient: server.Client(), token: "t", base: server.URL}
	if err := c.Heartbeat(context.Background(), "build-1", "claim/one"); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if err := c.PostResult(context.Background(), "build-1", "claim/one", buildResult{Status: buildSucceeded}); err != nil {
		t.Fatalf("PostResult: %v", err)
	}
	if heartbeatQuery != "claimant=claim%2Fone" {
		t.Fatalf("heartbeat query: %q", heartbeatQuery)
	}
	if resultQuery != "claimant=claim%2Fone" {
		t.Fatalf("result query: %q", resultQuery)
	}
	if got := claimantQuery(""); got != "" {
		t.Fatalf("an empty claimant should send nothing, got %q", got)
	}
}

func TestRunBuildHandsBackTheClaimant(t *testing.T) {
	sd := &fakeSpindrift{}
	b := &buildSource{
		sd:     sd,
		logger: testLogger(),
		stats:  newMetrics(),
		spawn: func(ctx context.Context, claim *buildClaim) (*skiff, error) {
			return nil, fmt.Errorf("no berth")
		},
	}
	b.runBuild(context.Background(), &buildClaim{ID: "build-1", Claimant: "claim-1"})

	posted := sd.postedResults()
	if len(posted) != 1 || posted[0].claimant != "claim-1" {
		t.Fatalf("expected the claim's token on the posted result, got %+v", posted)
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
