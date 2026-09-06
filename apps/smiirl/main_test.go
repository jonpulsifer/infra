package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func newTest(t *testing.T) (*server, *httptest.Server) {
	t.Helper()
	s, err := newServer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return s, ts
}

func do(t *testing.T, ts *httptest.Server, method, path, body string, hdr http.Header) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range hdr {
		req.Header[k] = v
	}
	if h := hdr.Get("Host"); h != "" {
		req.Host = h
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp, out
}

func TestBootstrapUsesHostHeader(t *testing.T) {
	_, ts := newTest(t)
	resp, out := do(t, ts, "GET", "/v1.0/aabbccddeeff/0123abcd", "", http.Header{"Host": {"api.smiirl.com"}})
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("status %d content-type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if out["url"] != "http://api.smiirl.com/aabbccddeeff/number" || out["v"] != "smiirl_2.0.7-1" || out["interval"] != float64(20) {
		t.Fatalf("bootstrap = %v", out)
	}
	if resp, _ := do(t, ts, "GET", "/v1.0/AABBCCDDEEFF/0123abcd", "", nil); resp.StatusCode != 404 {
		t.Fatalf("uppercase mac: status %d", resp.StatusCode)
	}
	if resp, _ := do(t, ts, "GET", "/nope", "", nil); resp.StatusCode != 404 {
		t.Fatalf("unknown path: status %d", resp.StatusCode)
	}
}

func TestStatusAcknowledged(t *testing.T) {
	_, ts := newTest(t)
	resp, out := do(t, ts, "POST", "/v1.0/aabbccddeeff/0123abcd/status",
		`{"eth":"","wlan":"10.66.6.4","version":"smiirl-2.0.7-1","counter_type":"esp32"}`, nil)
	if resp.StatusCode != 200 || out["result"] != true {
		t.Fatalf("status %d body %v", resp.StatusCode, out)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if state["device"].(map[string]any)["lastStatus"].(map[string]any)["wlan"] != "10.66.6.4" {
		t.Fatalf("state = %v", state)
	}
}

func TestSetValidation(t *testing.T) {
	_, ts := newTest(t)
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"number":0}`, 200},
		{`{"number":99999}`, 200},
		{`{"number":100000}`, 400},
		{`{"number":-1}`, 400},
		{`{"number":"abc"}`, 400},
		{`{}`, 400},
		{`abc`, 400},
	} {
		resp, out := do(t, ts, "PUT", "/api/number", tc.body, nil)
		if resp.StatusCode != tc.want {
			t.Errorf("%s: status %d, want %d (%v)", tc.body, resp.StatusCode, tc.want, out)
		}
		if tc.want == 400 && out["error"] == nil {
			t.Errorf("%s: no error field", tc.body)
		}
	}
	if resp, out := do(t, ts, "POST", "/api/number", `{"number":42}`, nil); resp.StatusCode != 200 || out["number"] != float64(42) {
		t.Fatalf("POST: status %d body %v", resp.StatusCode, out)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if state["number"] != float64(42) || state["device"].(map[string]any)["online"] != false {
		t.Fatalf("state = %v", state)
	}
}

func TestLongPoll(t *testing.T) {
	pollTimeout = 300 * time.Millisecond
	t.Cleanup(func() { pollTimeout = 12 * time.Second })
	_, ts := newTest(t)

	start := time.Now()
	resp, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil)
	if resp.StatusCode != 200 || out["number"] != float64(0) {
		t.Fatalf("status %d body %v", resp.StatusCode, out)
	}
	if d := time.Since(start); d < pollTimeout {
		t.Fatalf("returned after %v without a change", d)
	}
	_, state := do(t, ts, "GET", "/api/state", "", nil)
	if dev := state["device"].(map[string]any); dev["online"] != true || dev["lastPoll"] == nil {
		t.Fatalf("device = %v", dev)
	}

	pollTimeout = 10 * time.Second
	do(t, ts, "PUT", "/api/number", `{"number":3}`, nil)
	start = time.Now()
	if _, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil); out["number"] != float64(3) || time.Since(start) > time.Second {
		t.Fatalf("poll after a set between polls = %v after %v", out, time.Since(start))
	}

	got := make(chan map[string]any, 1)
	go func() {
		_, out := do(t, ts, "GET", "/aabbccddeeff/number", "", nil)
		got <- out
	}()
	time.Sleep(50 * time.Millisecond)
	do(t, ts, "PUT", "/api/number", `{"number":7}`, nil)
	select {
	case out := <-got:
		if out["number"] != float64(7) {
			t.Fatalf("poll = %v", out)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("poll did not return early on change")
	}
}

func TestPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := newServer(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.persisted.Number != 0 {
		t.Fatalf("fresh dir: number %d", s.persisted.Number)
	}
	if err := s.set(302); err != nil {
		t.Fatal(err)
	}
	again, err := newServer(dir)
	if err != nil {
		t.Fatal(err)
	}
	if again.persisted.Number != 302 || again.persisted.UpdatedAt.IsZero() {
		t.Fatalf("reloaded = %+v", again.persisted)
	}

	if err := os.WriteFile(s.path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	torn, err := newServer(dir)
	if err != nil || torn.persisted.Number != 0 {
		t.Fatalf("torn file: %v, %+v", err, torn)
	}
}
