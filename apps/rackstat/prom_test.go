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

// fakeProm is the prod-shaped adapter's counterpart: a real HTTP server, so
// the transport and its parsing are exercised end to end.
func fakeProm(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		switch {
		case r.URL.Path == "/api/v1/query_range":
			w.Write([]byte(`{"status":"success","data":{"result":[{"values":[[1,"8.25"],[2,"9.1"]]}]}}`))
		case strings.HasPrefix(q, `up{job="node-exporter"}`):
			w.Write([]byte(promVec(
				map[string]any{"node": "optiplex", "_value": "1"},
				map[string]any{"instance": "dns.lolwtf.ca:9100", "_value": "1"},
				map[string]any{"instance": "spore.lolwtf.ca:9100", "_value": "0"},
			)))
		case strings.HasPrefix(q, `max by (node, instance) (node_hwmon_temp_celsius)`):
			w.Write([]byte(promVec(map[string]any{"node": "optiplex", "_value": "54.3"})))
		case strings.HasPrefix(q, `kube_node_status_condition`):
			w.Write([]byte(promVec(map[string]any{"node": "optiplex", "_value": "1"})))
		case strings.HasPrefix(q, `ALERTS`):
			w.Write([]byte(promVec(
				map[string]any{"alertname": "KubeNodeNotReady", "severity": "critical", "_value": "1"},
			)))
		default:
			w.Write([]byte(promVec()))
		}
	}))
}

func newTestProm(t *testing.T) (*httpProm, *httptest.Server) {
	t.Helper()
	srv := fakeProm(t)
	t.Cleanup(srv.Close)
	return &httpProm{base: srv.URL, client: srv.Client()}, srv
}

func TestHTTPPromQuery(t *testing.T) {
	p, _ := newTestProm(t)

	samples, err := p.Query(context.Background(), queryNodeUp)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 3 {
		t.Fatalf("want 3 samples, got %+v", samples)
	}
	if samples[0].Metric["node"] != "optiplex" || samples[0].Value != 1 {
		t.Errorf("unexpected first sample: %+v", samples[0])
	}
	if samples[2].Value != 0 {
		t.Errorf("spore should parse as 0, got %v", samples[2].Value)
	}
}

func TestHTTPPromRange(t *testing.T) {
	p, _ := newTestProm(t)

	vals, err := p.Range(context.Background(), queryCPUHistory, 24*time.Hour, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	// values round to one decimal place
	if len(vals) != 2 || vals[0] != 8.3 || vals[1] != 9.1 {
		t.Errorf("unexpected range values: %+v", vals)
	}
}

func TestHTTPPromNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	p := &httpProm{base: srv.URL, client: srv.Client()}
	if _, err := p.Query(context.Background(), queryNodeUp); err == nil {
		t.Error("HTTP 503 should be an error")
	}
	if _, err := p.Range(context.Background(), queryCPUHistory, time.Hour, time.Minute); err == nil {
		t.Error("HTTP 503 should be an error")
	}
}

func TestHTTPPromStatusError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"status":"error","errorType":"bad_data"}`))
	}))
	defer srv.Close()

	p := &httpProm{base: srv.URL, client: srv.Client()}
	if _, err := p.Query(context.Background(), queryNodeUp); err == nil {
		t.Error(`{"status":"error"} should be an error`)
	}
}

// The adapter and the fleet module compose: this is the one test that runs
// the whole Prometheus half over real HTTP.
func TestCollectFleetOverHTTP(t *testing.T) {
	p, _ := newTestProm(t)

	f, err := collectFleet(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Nodes) != 3 || f.Nodes[0].Name != "optiplex" {
		t.Fatalf("unexpected nodes: %+v", f.Nodes)
	}
	if f.Nodes[0].TempC == nil || *f.Nodes[0].TempC != 54.3 {
		t.Errorf("optiplex temp = %v, want 54.3", f.Nodes[0].TempC)
	}
	if len(f.Alerts) != 1 || f.AlertCounts.Critical != 1 {
		t.Errorf("unexpected alerts: %+v %+v", f.Alerts, f.AlertCounts)
	}
	if len(f.CPUHistory) != 2 {
		t.Errorf("unexpected cpu history: %+v", f.CPUHistory)
	}
}
