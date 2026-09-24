package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func stubVlogs(t *testing.T, hits string, status int) func() []string {
	t.Helper()
	var mu sync.Mutex
	var asked []string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		asked = append(asked, r.URL.RawQuery)
		mu.Unlock()
		if got := r.Header.Get("AccountID"); got != vlogsAccountID {
			t.Errorf("AccountID header = %q, want %q", got, vlogsAccountID)
		}
		if status != http.StatusOK {
			http.Error(w, "boom", status)
			return
		}
		fmt.Fprintf(w, `{"hits":%q}`, hits)
	}))
	t.Cleanup(stub.Close)
	vlogsURL = stub.URL
	t.Cleanup(func() { vlogsURL = "http://victoria-logs-server.monitoring.svc.cluster.local:9428" })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), asked...)
	}
}

func TestRobocallsCount(t *testing.T) {
	asked := stubVlogs(t, "7", http.StatusOK)
	now := utc("2026-09-24T12:00:00Z") // 09:00 ADT
	n, err := robocallsCount(now, atlantic)
	if err != nil || n != 7 {
		t.Fatalf("robocallsCount = %d, %v", n, err)
	}
	q := asked()[0]
	for _, want := range []string{
		`_time%3A%5B2026-09-24T00%3A00%3A00-03%3A00%2C+now%5D`, // midnight in Canada/Atlantic
		`namespace%3D%22pbx%22`,
		`container%3D%22asterisk%22`,
		`pbx-event+kind%3Dscreened`,
		`-%22Executing%22`,
		`stats+count%28%29+as+hits`,
	} {
		if !strings.Contains(q, want) {
			t.Errorf("query %s missing %s", q, want)
		}
	}
}

func TestRobocallsCountZero(t *testing.T) {
	stubVlogs(t, "0", http.StatusOK)
	n, err := robocallsCount(utc("2026-09-24T12:00:00Z"), atlantic)
	if err != nil || n != 0 {
		t.Fatalf("robocallsCount = %d, %v", n, err)
	}
}

func TestRobocallsCountServerError(t *testing.T) {
	stubVlogs(t, "", http.StatusInternalServerError)
	if _, err := robocallsCount(utc("2026-09-24T12:00:00Z"), atlantic); err == nil {
		t.Fatal("expected an error on a non-200 response")
	}
}

func TestRobocallsCountBadHits(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"hits":"not-a-number"}`)
	}))
	t.Cleanup(stub.Close)
	vlogsURL = stub.URL
	t.Cleanup(func() { vlogsURL = "http://victoria-logs-server.monitoring.svc.cluster.local:9428" })
	if _, err := robocallsCount(utc("2026-09-24T12:00:00Z"), atlantic); err == nil {
		t.Fatal("expected an error on a non-numeric hits field")
	}
}

func TestRobocallsCountMidnightCrossesDST(t *testing.T) {
	// 2026-03-08 is the spring-forward day in Canada/Atlantic; midnight is
	// still -04:00 (AST) since the change happens at 02:00 local.
	asked := stubVlogs(t, "1", http.StatusOK)
	if _, err := robocallsCount(utc("2026-03-08T18:00:00Z"), atlantic); err != nil {
		t.Fatal(err)
	}
	if q := asked()[0]; !strings.Contains(q, `2026-03-08T00%3A00%3A00-04%3A00`) {
		t.Errorf("query %s did not anchor at local midnight", q)
	}
}
