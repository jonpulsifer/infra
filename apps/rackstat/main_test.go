package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseProbes(t *testing.T) {
	probes, err := parseProbes("wan=1.1.1.1:443, offsite=10.89.0.10:6443")
	if err != nil {
		t.Fatal(err)
	}
	if len(probes) != 2 || probes[0].Name != "wan" || probes[1].Addr != "10.89.0.10:6443" {
		t.Fatalf("unexpected probes: %+v", probes)
	}

	for _, bad := range []string{"noequals", "name=nohostport", "=1.1.1.1:443"} {
		if _, err := parseProbes(bad); err == nil {
			t.Errorf("parseProbes(%q) should fail", bad)
		}
	}

	if probes, err := parseProbes(""); err != nil || probes != nil {
		t.Errorf("empty PROBES should be nil, got %+v, %v", probes, err)
	}
}

func testServer(src promSource) *server {
	return &server{prom: src, clusterName: "folly", cacheTTL: time.Minute}
}

func TestSnapshotCachesAndServes(t *testing.T) {
	src := &cannedProm{
		vec: map[string][]promSample{
			queryNodeUp: {
				sample(1, "node", "optiplex"),
				sample(0, "instance", "spore.lolwtf.ca:9100"),
			},
		},
	}
	s := testServer(src)

	first := s.snapshot(context.Background())
	second := s.snapshot(context.Background())
	if first != second {
		t.Error("second snapshot within TTL should be the cached pointer")
	}

	rec := httptest.NewRecorder()
	s.handleSnapshot(rec, httptest.NewRequest(http.MethodGet, "/api/rackstat", nil))
	var decoded Snapshot
	if err := json.Unmarshal(rec.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if decoded.Cluster != "folly" {
		t.Errorf("unexpected cluster: %q", decoded.Cluster)
	}
	if len(decoded.Nodes) != 2 {
		t.Errorf("want 2 nodes over HTTP, got %d", len(decoded.Nodes))
	}
	if decoded.Errors != nil {
		t.Errorf("healthy snapshot should carry no errors, got %v", decoded.Errors)
	}
	// probes is never null in the JSON: the pixlet app iterates it directly
	if decoded.Probes == nil {
		t.Error("probes should serialize as an empty array, not null")
	}
}

func TestSnapshotReportsSourceErrors(t *testing.T) {
	src := &cannedProm{errs: map[string]error{queryNodeUp: context.DeadlineExceeded}}
	snap := testServer(src).snapshot(context.Background())

	if snap.Errors["prometheus"] == "" {
		t.Fatalf("a failed node list should be reported, got %+v", snap.Errors)
	}
	if len(snap.Nodes) != 0 {
		t.Errorf("want no nodes, got %+v", snap.Nodes)
	}
}
