// rackstat aggregates homelab health into a single JSON snapshot for the
// rack-top Tidbyt/Tronbyt display (apps/rackstat/rackstat.star). It fans out
// to three sources and degrades gracefully when any of them is unavailable:
//
//   - Prometheus: node up/temp/cpu/mem (node-exporter, incl. bare hosts),
//     firing alerts (minus the always-firing Watchdog/InfoInhibitor), k8s
//     node readiness, and a 24h cluster CPU history for the sparkline page.
//     Read through the promSource port (prom.go), modelled in fleet.go.
//   - Kubernetes API: Flux Kustomization/HelmRelease readiness and the last
//     applied revision. Flux metrics aren't scraped into Prometheus, so we
//     read the CRDs directly with a read-only ClusterRole (kube.go).
//   - TCP probes: WAN, the offsite cluster over the Site Magic tunnel, and a
//     local LB VIP. Probing the data path catches "BGP looks fine but the
//     gateway isn't programming routes" failures that session-state metrics
//     miss.
//
// The snapshot is cached briefly so a wall of Tronbyt render ticks doesn't
// hammer Prometheus.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Snapshot is the JSON blob served to the pixlet app.
type Snapshot struct {
	GeneratedAt time.Time         `json:"generated_at"`
	Cluster     string            `json:"cluster"`
	Nodes       []Node            `json:"nodes"`
	Alerts      []Alert           `json:"alerts"`
	AlertCounts AlertCounts       `json:"alert_counts"`
	GitOps      *GitOps           `json:"gitops,omitempty"`
	Probes      []ProbeResult     `json:"probes"`
	CPUHistory  []float64         `json:"cpu_history,omitempty"`
	Errors      map[string]string `json:"errors,omitempty"`
}

// Node is one machine known to Prometheus' node-exporter job. K8s nodes also
// carry cluster readiness; bare hosts just have exporter reachability.
type Node struct {
	Name   string   `json:"name"`
	Up     bool     `json:"up"`
	K8s    bool     `json:"k8s"`
	Ready  *bool    `json:"ready,omitempty"`
	TempC  *float64 `json:"temp_c,omitempty"`
	CPUPct *float64 `json:"cpu_pct,omitempty"`
	MemPct *float64 `json:"mem_pct,omitempty"`
}

type Alert struct {
	Name     string `json:"name"`
	Severity string `json:"severity"`
	Count    int    `json:"count"`
}

type AlertCounts struct {
	Critical int `json:"critical"`
	Warning  int `json:"warning"`
	Info     int `json:"info"`
}

type GitOps struct {
	KustomizationsReady int    `json:"ks_ready"`
	KustomizationsTotal int    `json:"ks_total"`
	HelmReleasesReady   int    `json:"hr_ready"`
	HelmReleasesTotal   int    `json:"hr_total"`
	Revision            string `json:"revision,omitempty"`
}

type ProbeResult struct {
	Name string `json:"name"`
	Ok   bool   `json:"ok"`
	Ms   int64  `json:"ms"`
}

// Probe is a named TCP dial target, configured via PROBES.
type Probe struct {
	Name string
	Addr string
}

type server struct {
	prom        promSource
	clusterName string
	probes      []Probe
	kube        *kubeClient // nil when not running in-cluster
	cacheTTL    time.Duration

	mu       sync.Mutex
	cached   *Snapshot
	cachedAt time.Time
}

func main() {
	promURL := envOr("PROM_URL", "http://prom-stack-kube-prometheus-prometheus.monitoring.svc:9090")
	listen := envOr("LISTEN_ADDR", ":8080")
	cluster := envOr("CLUSTER_NAME", "folly")
	ttl, err := time.ParseDuration(envOr("CACHE_TTL", "15s"))
	if err != nil {
		log.Fatalf("invalid CACHE_TTL: %v", err)
	}

	probes, err := parseProbes(os.Getenv("PROBES"))
	if err != nil {
		log.Fatalf("invalid PROBES: %v", err)
	}

	kube, err := newKubeClient()
	if err != nil {
		log.Printf("flux status disabled (no in-cluster credentials): %v", err)
	}

	s := &server{
		prom: &httpProm{
			base:   strings.TrimRight(promURL, "/"),
			client: &http.Client{Timeout: 10 * time.Second},
		},
		clusterName: cluster,
		probes:      probes,
		kube:        kube,
		cacheTTL:    ttl,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/rackstat", s.handleSnapshot)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	log.Printf("rackstat listening on %s (prometheus %s, %d probes, flux=%v)",
		listen, promURL, len(probes), kube != nil)
	log.Fatal(http.ListenAndServe(listen, mux))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// parseProbes parses "wan=1.1.1.1:443,offsite=10.89.0.10:6443".
func parseProbes(raw string) ([]Probe, error) {
	if raw == "" {
		return nil, nil
	}
	var probes []Probe
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, addr, ok := strings.Cut(part, "=")
		if !ok || name == "" || addr == "" {
			return nil, fmt.Errorf("probe %q is not name=host:port", part)
		}
		if _, _, err := net.SplitHostPort(addr); err != nil {
			return nil, fmt.Errorf("probe %q: %w", part, err)
		}
		probes = append(probes, Probe{Name: name, Addr: addr})
	}
	return probes, nil
}

func (s *server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	snap := s.snapshot(r.Context())
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(snap); err != nil {
		log.Printf("encode: %v", err)
	}
}

func (s *server) snapshot(ctx context.Context) *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cached != nil && time.Since(s.cachedAt) < s.cacheTTL {
		return s.cached
	}

	ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()

	snap := &Snapshot{
		GeneratedAt: time.Now().UTC(),
		Cluster:     s.clusterName,
		Errors:      map[string]string{},
	}

	var wg sync.WaitGroup
	var promErr, fluxErr error
	var f fleet
	var gitops *GitOps
	probeResults := make([]ProbeResult, len(s.probes))

	wg.Add(1)
	go func() {
		defer wg.Done()
		f, promErr = collectFleet(ctx, s.prom)
	}()

	if s.kube != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			gitops, fluxErr = s.kube.collectFlux(ctx)
		}()
	}

	for i, p := range s.probes {
		wg.Add(1)
		go func(i int, p Probe) {
			defer wg.Done()
			probeResults[i] = runProbe(p)
		}(i, p)
	}

	wg.Wait()

	snap.Nodes = f.Nodes
	snap.Alerts = f.Alerts
	snap.AlertCounts = f.AlertCounts
	snap.CPUHistory = f.CPUHistory
	snap.GitOps = gitops
	snap.Probes = probeResults
	if promErr != nil {
		snap.Errors["prometheus"] = promErr.Error()
	}
	if fluxErr != nil {
		snap.Errors["flux"] = fluxErr.Error()
	}
	if len(snap.Errors) == 0 {
		snap.Errors = nil
	}

	s.cached = snap
	s.cachedAt = time.Now()
	return snap
}

func runProbe(p Probe) ProbeResult {
	start := time.Now()
	conn, err := net.DialTimeout("tcp", p.Addr, 2*time.Second)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		return ProbeResult{Name: p.Name, Ok: false, Ms: ms}
	}
	conn.Close()
	return ProbeResult{Name: p.Name, Ok: true, Ms: ms}
}
