package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestNodeName(t *testing.T) {
	cases := []struct {
		metric map[string]string
		want   string
	}{
		{map[string]string{"node": "optiplex"}, "optiplex"},
		{map[string]string{"instance": "homepi4-wifi.lolwtf.ca:9100"}, "homepi4-wifi"},
		{map[string]string{"instance": "cloudpi4:9100"}, "cloudpi4"},
		{map[string]string{"instance": "radiopi0"}, "radiopi0"},
		{map[string]string{}, ""},
	}
	for _, c := range cases {
		if got := nodeName(c.metric); got != c.want {
			t.Errorf("nodeName(%v) = %q, want %q", c.metric, got, c.want)
		}
	}
}

// promVec builds a query API response with one sample per (metric, value).
func promVec(samples ...map[string]any) string {
	results := []map[string]any{}
	for _, s := range samples {
		metric := map[string]string{}
		for k, v := range s {
			if k != "_value" {
				metric[k] = v.(string)
			}
		}
		results = append(results, map[string]any{
			"metric": metric,
			"value":  []any{1700000000.0, s["_value"].(string)},
		})
	}
	b, _ := json.Marshal(map[string]any{
		"status": "success",
		"data":   map[string]any{"resultType": "vector", "result": results},
	})
	return string(b)
}

func fakeProm(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		switch {
		case strings.HasPrefix(q, `up{job="node-exporter"}`):
			w.Write([]byte(promVec(
				map[string]any{"node": "optiplex", "_value": "1"},
				map[string]any{"node": "riptide", "_value": "1"},
				map[string]any{"instance": "tallboy.lolwtf.ca:9100", "_value": "0"},
				map[string]any{"instance": "cloudpi4:9100", "_value": "1"},
			)))
		case strings.HasPrefix(q, `max by (node, instance) (node_hwmon_temp_celsius)`):
			w.Write([]byte(promVec(map[string]any{"node": "optiplex", "_value": "54.3"})))
		case strings.HasPrefix(q, `kube_node_status_condition`):
			w.Write([]byte(promVec(
				map[string]any{"node": "optiplex", "_value": "1"},
				map[string]any{"node": "riptide", "_value": "0"},
			)))
		case strings.HasPrefix(q, `ALERTS`):
			w.Write([]byte(promVec(
				map[string]any{"alertname": "TargetDown", "severity": "warning", "_value": "1"},
				map[string]any{"alertname": "TargetDown", "severity": "warning", "_value": "1"},
				map[string]any{"alertname": "KubeNodeNotReady", "severity": "critical", "_value": "1"},
			)))
		case r.URL.Path == "/api/v1/query_range":
			w.Write([]byte(`{"status":"success","data":{"result":[{"values":[[1,"8.25"],[2,"9.1"]]}]}}`))
		default:
			w.Write([]byte(promVec()))
		}
	}))
}

func TestCollectProm(t *testing.T) {
	prom := fakeProm(t)
	defer prom.Close()

	s := &server{promURL: prom.URL, client: prom.Client(), cacheTTL: time.Minute}
	snap := &Snapshot{}
	if err := s.collectProm(context.Background(), snap); err != nil {
		t.Fatal(err)
	}

	if len(snap.Nodes) != 4 {
		t.Fatalf("want 4 nodes, got %+v", snap.Nodes)
	}
	// k8s nodes sort first
	if !snap.Nodes[0].K8s || snap.Nodes[0].Name != "optiplex" {
		t.Errorf("first node should be k8s optiplex, got %+v", snap.Nodes[0])
	}
	if snap.Nodes[1].Ready == nil || *snap.Nodes[1].Ready {
		t.Errorf("riptide should be k8s and not ready, got %+v", snap.Nodes[1])
	}
	for _, n := range snap.Nodes {
		if n.Name == "tallboy" && n.Up {
			t.Errorf("tallboy should be down")
		}
	}
	if snap.Nodes[0].TempC == nil || *snap.Nodes[0].TempC != 54.3 {
		t.Errorf("optiplex temp = %+v, want 54.3", snap.Nodes[0].TempC)
	}

	// alerts: critical sorts first, duplicates collapse with a count
	if len(snap.Alerts) != 2 || snap.Alerts[0].Name != "KubeNodeNotReady" {
		t.Fatalf("unexpected alerts: %+v", snap.Alerts)
	}
	if snap.Alerts[1].Count != 2 {
		t.Errorf("TargetDown count = %d, want 2", snap.Alerts[1].Count)
	}
	if snap.AlertCounts.Critical != 1 || snap.AlertCounts.Warning != 2 {
		t.Errorf("unexpected alert counts: %+v", snap.AlertCounts)
	}

	if len(snap.CPUHistory) != 2 || snap.CPUHistory[0] != 8.3 {
		t.Errorf("unexpected cpu history: %+v", snap.CPUHistory)
	}
}

func TestSnapshotCachesAndServes(t *testing.T) {
	prom := fakeProm(t)
	defer prom.Close()

	s := &server{promURL: prom.URL, client: prom.Client(), cacheTTL: time.Minute}
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
	if decoded.Cluster != "" && decoded.Cluster != "folly" {
		t.Errorf("unexpected cluster: %q", decoded.Cluster)
	}
	if len(decoded.Nodes) != 4 {
		t.Errorf("want 4 nodes over HTTP, got %d", len(decoded.Nodes))
	}
}
