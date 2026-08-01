package main

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// sample builds a promSample from alternating label/value pairs.
func sample(value float64, labels ...string) promSample {
	m := map[string]string{}
	for i := 0; i+1 < len(labels); i += 2 {
		m[labels[i]] = labels[i+1]
	}
	return promSample{Metric: m, Value: value}
}

// cannedProm is the second adapter behind promSource: it answers queries from
// a table instead of a Prometheus, so the fleet module is exercised without
// an HTTP server.
type cannedProm struct {
	vec  map[string][]promSample
	rng  []float64
	errs map[string]error
}

func (c *cannedProm) Query(_ context.Context, query string) ([]promSample, error) {
	if err, ok := c.errs[query]; ok {
		return nil, err
	}
	return c.vec[query], nil
}

func (c *cannedProm) Range(_ context.Context, query string, _, _ time.Duration) ([]float64, error) {
	if err, ok := c.errs[query]; ok {
		return nil, err
	}
	if c.rng == nil {
		return nil, fmt.Errorf("no data")
	}
	return c.rng, nil
}

func TestNodeName(t *testing.T) {
	cases := []struct {
		metric map[string]string
		want   string
	}{
		{map[string]string{"node": "optiplex"}, "optiplex"},
		{map[string]string{"instance": "dns.lolwtf.ca:9100"}, "dns"},
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

func TestBuildNodes(t *testing.T) {
	nodes := buildNodes(fleetSamples{
		Up: []promSample{
			sample(1, "node", "optiplex"),
			sample(1, "node", "riptide"),
			sample(1, "instance", "dns.lolwtf.ca:9100"),
			sample(0, "instance", "spore.lolwtf.ca:9100"),
			sample(1, "instance", "cloudpi4:9100"),
		},
		Temp: []promSample{sample(54.32, "node", "optiplex")},
		Mem:  []promSample{sample(49.55, "node", "optiplex")},
		Ready: []promSample{
			sample(1, "node", "optiplex"),
			sample(0, "node", "riptide"),
		},
	})

	if len(nodes) != 5 {
		t.Fatalf("want 5 nodes, got %+v", nodes)
	}
	// k8s nodes sort first, both groups alphabetical
	var order []string
	for _, n := range nodes {
		order = append(order, n.Name)
	}
	want := []string{"optiplex", "riptide", "cloudpi4", "dns", "spore"}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("node order = %v, want %v", order, want)
		}
	}
	if !nodes[0].K8s || nodes[0].Ready == nil || !*nodes[0].Ready {
		t.Errorf("optiplex should be a ready k8s node, got %+v", nodes[0])
	}
	if nodes[1].Ready == nil || *nodes[1].Ready {
		t.Errorf("riptide should be k8s and not ready, got %+v", nodes[1])
	}
	if nodes[4].Name != "spore" || nodes[4].Up {
		t.Errorf("spore should be down, got %+v", nodes[4])
	}
	if nodes[0].TempC == nil || *nodes[0].TempC != 54.3 {
		t.Errorf("optiplex temp = %v, want 54.3", nodes[0].TempC)
	}
	if nodes[0].MemPct == nil || *nodes[0].MemPct != 49.6 {
		t.Errorf("optiplex mem = %v, want 49.6", nodes[0].MemPct)
	}
	if nodes[0].CPUPct != nil {
		t.Errorf("absent cpu series should stay nil, got %v", nodes[0].CPUPct)
	}
	// a bare host never gains k8s readiness
	if nodes[3].K8s || nodes[3].Ready != nil {
		t.Errorf("dns is a bare host, got %+v", nodes[3])
	}
}

func TestBuildAlerts(t *testing.T) {
	alerts, counts := buildAlerts([]promSample{
		sample(1, "alertname", "TargetDown", "severity", "warning"),
		sample(1, "alertname", "TargetDown", "severity", "warning"),
		sample(1, "alertname", "KubeNodeNotReady", "severity", "critical"),
		sample(1, "alertname", "Chatty"),
	})

	if len(alerts) != 3 {
		t.Fatalf("want 3 distinct alerts, got %+v", alerts)
	}
	if alerts[0].Name != "KubeNodeNotReady" {
		t.Errorf("critical should sort first, got %+v", alerts)
	}
	if alerts[1].Name != "TargetDown" || alerts[1].Count != 2 {
		t.Errorf("TargetDown should collapse to count 2, got %+v", alerts[1])
	}
	if alerts[2].Severity != "none" {
		t.Errorf("missing severity should become %q, got %q", "none", alerts[2].Severity)
	}
	if counts.Critical != 1 || counts.Warning != 2 || counts.Info != 1 {
		t.Errorf("unexpected counts: %+v", counts)
	}
}

func TestBuildAlertsEmpty(t *testing.T) {
	alerts, counts := buildAlerts(nil)
	if len(alerts) != 0 {
		t.Errorf("want no alerts, got %+v", alerts)
	}
	if counts != (AlertCounts{}) {
		t.Errorf("want zero counts, got %+v", counts)
	}
}

func TestCollectFleetDegradesPerQuery(t *testing.T) {
	src := &cannedProm{
		vec: map[string][]promSample{
			queryNodeUp:  {sample(1, "node", "optiplex")},
			queryNodeCPU: {sample(14.8, "node", "optiplex")},
			queryAlerts:  {sample(1, "alertname", "TargetDown", "severity", "warning")},
		},
		errs: map[string]error{
			queryNodeTemp:   fmt.Errorf("boom"),
			queryCPUHistory: fmt.Errorf("boom"),
		},
	}

	f, err := collectFleet(context.Background(), src)
	if err != nil {
		t.Fatalf("a failed enrichment must not fail the fleet: %v", err)
	}
	if len(f.Nodes) != 1 || f.Nodes[0].Name != "optiplex" {
		t.Fatalf("unexpected nodes: %+v", f.Nodes)
	}
	if f.Nodes[0].TempC != nil {
		t.Errorf("failed temp query should leave temp nil, got %v", f.Nodes[0].TempC)
	}
	if f.Nodes[0].CPUPct == nil || *f.Nodes[0].CPUPct != 14.8 {
		t.Errorf("cpu should survive a failed temp query, got %v", f.Nodes[0].CPUPct)
	}
	if len(f.Alerts) != 1 {
		t.Errorf("alerts should survive, got %+v", f.Alerts)
	}
	if f.CPUHistory != nil {
		t.Errorf("failed range query should leave history nil, got %v", f.CPUHistory)
	}
}

func TestCollectFleetFailsWithoutNodeList(t *testing.T) {
	src := &cannedProm{errs: map[string]error{queryNodeUp: fmt.Errorf("prometheus down")}}
	if _, err := collectFleet(context.Background(), src); err == nil {
		t.Fatal("a failed node list must fail the fleet")
	}
}
