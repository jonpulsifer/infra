package view_counter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync"
	"testing"
)

type inMemoryCounterStore struct {
	mu     sync.Mutex
	counts map[string]int64
}

func newInMemoryCounterStore() *inMemoryCounterStore {
	return &inMemoryCounterStore{counts: map[string]int64{}}
}

func (s *inMemoryCounterStore) Next(_ context.Context, label string) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.counts[label]++
	return s.counts[label], nil
}

func TestViewCounterGet(t *testing.T) {
	t.Setenv("GOOGLE_CLOUD_PROJECT", "")
	t.Setenv("GCP_PROJECT", "")

	handler := viewCounterWithStore(newInMemoryCounterStore())

	body := performRequest(t, handler, "/")
	assertSVGText(t, body, "1")

	body = performRequest(t, handler, "/")
	assertSVGText(t, body, "2")

	body = performRequest(t, handler, "/?label=TestLabel")
	assertSVGText(t, body, "TestLabel")
	assertSVGText(t, body, "1")
}

func performRequest(t *testing.T, handler http.Handler, path string) string {
	t.Helper()

	req := httptest.NewRequest("GET", path, nil)
	rr := httptest.NewRecorder()

	handler.ServeHTTP(rr, req)

	contentType := "image/svg+xml"
	if got := rr.Header().Get("Content-Type"); got != contentType {
		t.Fatalf("Wrong Content-Type. got: %q, want: %q", got, contentType)
	}

	return rr.Body.String()
}

func assertSVGText(t *testing.T, body, text string) {
	t.Helper()

	r := regexp.MustCompile("<text.+>" + regexp.QuoteMeta(text) + "</text>")
	if !r.MatchString(body) {
		t.Fatalf("Could not find SVG text %q, got: %q", text, body)
	}
}
