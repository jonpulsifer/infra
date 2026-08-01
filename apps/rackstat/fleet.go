package main

import (
	"context"
	"net"
	"sort"
	"strings"
	"time"
)

// fleet is everything the Prometheus half of a snapshot contributes.
type fleet struct {
	Nodes       []Node
	Alerts      []Alert
	AlertCounts AlertCounts
	CPUHistory  []float64
}

// fleetSamples is the raw material collectFleet gathers before any modelling
// happens. Keeping it a value is what lets buildNodes be exercised from
// literals instead of an HTTP server.
type fleetSamples struct {
	Up    []promSample
	Temp  []promSample
	CPU   []promSample
	Mem   []promSample
	Ready []promSample
}

// collectFleet reads a source and models what comes back. Only the node list
// is required; every enrichment degrades on its own so a failed sub-query
// cannot hide the fleet.
func collectFleet(ctx context.Context, src promSource) (fleet, error) {
	up, err := src.Query(ctx, queryNodeUp)
	if err != nil {
		return fleet{}, err // nothing else is useful without the node list
	}

	samples := fleetSamples{Up: up}
	samples.Temp, _ = src.Query(ctx, queryNodeTemp)
	samples.CPU, _ = src.Query(ctx, queryNodeCPU)
	samples.Mem, _ = src.Query(ctx, queryNodeMem)
	samples.Ready, _ = src.Query(ctx, queryNodeReady)

	f := fleet{Nodes: buildNodes(samples)}

	if alerts, err := src.Query(ctx, queryAlerts); err == nil {
		f.Alerts, f.AlertCounts = buildAlerts(alerts)
	}
	if hist, err := src.Range(ctx, queryCPUHistory, 24*time.Hour, time.Hour); err == nil {
		f.CPUHistory = hist
	}
	return f, nil
}

// buildNodes turns node-exporter series into the node list, k8s nodes first
// and both groups alphabetical.
func buildNodes(s fleetSamples) []Node {
	nodes := map[string]*Node{}
	var names []string
	for _, sm := range s.Up {
		name := nodeName(sm.Metric)
		if name == "" {
			continue
		}
		if _, ok := nodes[name]; !ok {
			names = append(names, name)
		}
		nodes[name] = &Node{Name: name, Up: sm.Value == 1}
	}

	enrich(nodes, s.Temp, func(n *Node, v float64) { n.TempC = ptr(round1(v)) })
	enrich(nodes, s.CPU, func(n *Node, v float64) { n.CPUPct = ptr(round1(v)) })
	enrich(nodes, s.Mem, func(n *Node, v float64) { n.MemPct = ptr(round1(v)) })

	for _, sm := range s.Ready {
		if n, ok := nodes[sm.Metric["node"]]; ok {
			n.K8s = true
			n.Ready = ptr(sm.Value == 1)
		}
	}

	sort.Strings(names)
	sort.SliceStable(names, func(i, j int) bool {
		return nodes[names[i]].K8s && !nodes[names[j]].K8s
	})
	out := make([]Node, 0, len(names))
	for _, name := range names {
		out = append(out, *nodes[name])
	}
	return out
}

func enrich(nodes map[string]*Node, samples []promSample, set func(*Node, float64)) {
	for _, sm := range samples {
		if n, ok := nodes[nodeName(sm.Metric)]; ok {
			set(n, sm.Value)
		}
	}
}

// buildAlerts collapses firing alerts by (name, severity), most severe first.
func buildAlerts(samples []promSample) ([]Alert, AlertCounts) {
	byKey := map[string]*Alert{}
	var keys []string
	for _, sm := range samples {
		sev := sm.Metric["severity"]
		if sev == "" {
			sev = "none"
		}
		key := sm.Metric["alertname"] + "\x00" + sev
		if a, ok := byKey[key]; ok {
			a.Count++
			continue
		}
		byKey[key] = &Alert{Name: sm.Metric["alertname"], Severity: sev, Count: 1}
		keys = append(keys, key)
	}
	sort.SliceStable(keys, func(i, j int) bool {
		return severityRank(byKey[keys[i]].Severity) < severityRank(byKey[keys[j]].Severity)
	})

	alerts := make([]Alert, 0, len(keys))
	var counts AlertCounts
	for _, k := range keys {
		a := byKey[k]
		alerts = append(alerts, *a)
		switch a.Severity {
		case "critical":
			counts.Critical += a.Count
		case "warning":
			counts.Warning += a.Count
		default:
			counts.Info += a.Count
		}
	}
	return alerts, counts
}

func severityRank(s string) int {
	switch s {
	case "critical":
		return 0
	case "warning":
		return 1
	default:
		return 2
	}
}

// nodeName normalizes a node-exporter series to a short host name: prefer
// the k8s node label, else the host part of instance ("dns.lolwtf.ca:9100"
// -> "dns").
func nodeName(metric map[string]string) string {
	if n := metric["node"]; n != "" {
		return n
	}
	inst := metric["instance"]
	if inst == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(inst); err == nil {
		inst = host
	}
	name, _, _ := strings.Cut(inst, ".")
	return name
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

func ptr[T any](v T) *T { return &v }
