// rackstat aggregates homelab health into a single JSON snapshot for the
// rack-top Tidbyt/Tronbyt display (apps/rackstat/rackstat.star). It fans out
// to three sources and degrades gracefully when any of them is unavailable:
//
//   - Prometheus: node up/temp/cpu/mem (node-exporter, incl. the bare Pis),
//     firing alerts (minus the always-firing Watchdog/InfoInhibitor), k8s
//     node readiness, and a 24h cluster CPU history for the sparkline page.
//   - Kubernetes API: Flux Kustomization/HelmRelease readiness and the last
//     applied revision. Flux metrics aren't scraped into Prometheus, so we
//     read the CRDs directly with a read-only ClusterRole.
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
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	saTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	saCAPath    = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
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
// carry cluster readiness; the bare Pis just have exporter reachability.
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
	promURL     string
	clusterName string
	probes      []Probe
	kube        *kubeClient // nil when not running in-cluster
	cacheTTL    time.Duration
	client      *http.Client

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
		promURL:     strings.TrimRight(promURL, "/"),
		clusterName: cluster,
		probes:      probes,
		kube:        kube,
		cacheTTL:    ttl,
		client:      &http.Client{Timeout: 10 * time.Second},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/rackstat", s.handleSnapshot)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	log.Printf("rackstat listening on %s (prometheus %s, %d probes, flux=%v)",
		listen, s.promURL, len(probes), kube != nil)
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
	var gitops *GitOps
	probeResults := make([]ProbeResult, len(s.probes))

	wg.Add(1)
	go func() {
		defer wg.Done()
		promErr = s.collectProm(ctx, snap)
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

// ---------------------------------------------------------------------------
// Prometheus
// ---------------------------------------------------------------------------

type promSample struct {
	Metric map[string]string
	Value  float64
}

func (s *server) collectProm(ctx context.Context, snap *Snapshot) error {
	up, err := s.promQuery(ctx, `up{job="node-exporter"}`)
	if err != nil {
		return err // nothing else is useful without the node list
	}

	nodes := map[string]*Node{}
	var names []string
	for _, sm := range up {
		name := nodeName(sm.Metric)
		if name == "" {
			continue
		}
		if _, ok := nodes[name]; !ok {
			names = append(names, name)
		}
		nodes[name] = &Node{Name: name, Up: sm.Value == 1}
	}

	// Best-effort enrichment; a failed sub-query shouldn't hide the fleet.
	if temps, err := s.promQuery(ctx, `max by (node, instance) (node_hwmon_temp_celsius)`); err == nil {
		for _, sm := range temps {
			if n, ok := nodes[nodeName(sm.Metric)]; ok {
				n.TempC = round1p(sm.Value)
			}
		}
	}
	if cpus, err := s.promQuery(ctx, `100 - avg by (node, instance) (rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m])) * 100`); err == nil {
		for _, sm := range cpus {
			if n, ok := nodes[nodeName(sm.Metric)]; ok {
				n.CPUPct = round1p(sm.Value)
			}
		}
	}
	if mems, err := s.promQuery(ctx, `(1 - node_memory_MemAvailable_bytes{job="node-exporter"} / node_memory_MemTotal_bytes{job="node-exporter"}) * 100`); err == nil {
		for _, sm := range mems {
			if n, ok := nodes[nodeName(sm.Metric)]; ok {
				n.MemPct = round1p(sm.Value)
			}
		}
	}
	if ready, err := s.promQuery(ctx, `kube_node_status_condition{condition="Ready",status="true"}`); err == nil {
		for _, sm := range ready {
			if n, ok := nodes[sm.Metric["node"]]; ok {
				n.K8s = true
				v := sm.Value == 1
				n.Ready = &v
			}
		}
	}

	sort.Strings(names)
	// k8s nodes first, then the bare hosts, both alphabetical.
	sort.SliceStable(names, func(i, j int) bool {
		return nodes[names[i]].K8s && !nodes[names[j]].K8s
	})
	for _, name := range names {
		snap.Nodes = append(snap.Nodes, *nodes[name])
	}

	// Watchdog and InfoInhibitor fire forever by design; they are noise here.
	alerts, err := s.promQuery(ctx, `ALERTS{alertstate="firing",alertname!~"Watchdog|InfoInhibitor"}`)
	if err == nil {
		byKey := map[string]*Alert{}
		var keys []string
		for _, sm := range alerts {
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
		sort.Slice(keys, func(i, j int) bool {
			return severityRank(byKey[keys[i]].Severity) < severityRank(byKey[keys[j]].Severity)
		})
		for _, k := range keys {
			a := byKey[k]
			snap.Alerts = append(snap.Alerts, *a)
			switch a.Severity {
			case "critical":
				snap.AlertCounts.Critical += a.Count
			case "warning":
				snap.AlertCounts.Warning += a.Count
			default:
				snap.AlertCounts.Info += a.Count
			}
		}
	}

	if hist, err := s.promRange(ctx,
		`100 * (1 - avg(rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[10m])))`,
		24*time.Hour, time.Hour); err == nil {
		snap.CPUHistory = hist
	}

	return nil
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
// the k8s node label, else the host part of instance ("homepi4.lolwtf.ca:9100"
// -> "homepi4").
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

func round1p(v float64) *float64 {
	r := float64(int(v*10+0.5)) / 10
	return &r
}

func (s *server) promQuery(ctx context.Context, query string) ([]promSample, error) {
	body, err := s.promGET(ctx, "/api/v1/query", url.Values{"query": {query}})
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("prometheus response: %w", err)
	}
	if resp.Status != "success" {
		return nil, fmt.Errorf("prometheus query %q: status %s", query, resp.Status)
	}
	samples := make([]promSample, 0, len(resp.Data.Result))
	for _, r := range resp.Data.Result {
		str, _ := r.Value[1].(string)
		v, err := strconv.ParseFloat(str, 64)
		if err != nil {
			continue
		}
		samples = append(samples, promSample{Metric: r.Metric, Value: v})
	}
	return samples, nil
}

// promRange returns the values of the first series of a range query.
func (s *server) promRange(ctx context.Context, query string, window, step time.Duration) ([]float64, error) {
	end := time.Now()
	vals := url.Values{
		"query": {query},
		"start": {strconv.FormatInt(end.Add(-window).Unix(), 10)},
		"end":   {strconv.FormatInt(end.Unix(), 10)},
		"step":  {strconv.FormatInt(int64(step.Seconds()), 10)},
	}
	body, err := s.promGET(ctx, "/api/v1/query_range", vals)
	if err != nil {
		return nil, err
	}
	var resp struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				Values [][2]any `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("prometheus response: %w", err)
	}
	if resp.Status != "success" || len(resp.Data.Result) == 0 {
		return nil, fmt.Errorf("prometheus range query %q: no data", query)
	}
	var out []float64
	for _, v := range resp.Data.Result[0].Values {
		str, _ := v[1].(string)
		f, err := strconv.ParseFloat(str, 64)
		if err != nil {
			continue
		}
		out = append(out, float64(int(f*10+0.5))/10)
	}
	return out, nil
}

func (s *server) promGET(ctx context.Context, path string, vals url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.promURL+path+"?"+vals.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus %s: HTTP %d", path, resp.StatusCode)
	}
	body := make([]byte, 0, 64<<10)
	buf := make([]byte, 32<<10)
	for {
		n, err := resp.Body.Read(buf)
		body = append(body, buf[:n]...)
		if err != nil {
			break
		}
		if len(body) > 8<<20 {
			return nil, fmt.Errorf("prometheus %s: response too large", path)
		}
	}
	return body, nil
}

// ---------------------------------------------------------------------------
// Kubernetes API (Flux CRDs)
// ---------------------------------------------------------------------------

type kubeClient struct {
	base   string
	token  string
	rootKS string // kustomization whose lastAppliedRevision represents "the repo"
	client *http.Client
}

// newKubeClient builds a raw REST client from the in-cluster service account
// mount; client-go would be a heavy dependency for two GETs.
func newKubeClient() (*kubeClient, error) {
	host, port := os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")
	if host == "" || port == "" {
		return nil, fmt.Errorf("not running in a cluster")
	}
	token, err := os.ReadFile(saTokenPath)
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(saCAPath)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("invalid service account CA")
	}
	return &kubeClient{
		base:   "https://" + net.JoinHostPort(host, port),
		token:  strings.TrimSpace(string(token)),
		rootKS: envOr("ROOT_KUSTOMIZATION", "apps"),
		client: &http.Client{
			Timeout: 10 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{RootCAs: pool},
			},
		},
	}, nil
}

type fluxList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Status struct {
			LastAppliedRevision string `json:"lastAppliedRevision"`
			Conditions          []struct {
				Type   string `json:"type"`
				Status string `json:"status"`
			} `json:"conditions"`
		} `json:"status"`
	} `json:"items"`
}

func (k *kubeClient) collectFlux(ctx context.Context) (*GitOps, error) {
	ks, err := k.fluxGET(ctx, "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations")
	if err != nil {
		return nil, err
	}
	hr, err := k.fluxGET(ctx, "/apis/helm.toolkit.fluxcd.io/v2/helmreleases")
	if err != nil {
		return nil, err
	}

	g := &GitOps{KustomizationsTotal: len(ks.Items), HelmReleasesTotal: len(hr.Items)}
	for _, item := range ks.Items {
		if isReady(item.Status.Conditions) {
			g.KustomizationsReady++
		}
		if item.Metadata.Namespace == "flux-system" && item.Metadata.Name == k.rootKS {
			g.Revision = item.Status.LastAppliedRevision
		}
	}
	for _, item := range hr.Items {
		if isReady(item.Status.Conditions) {
			g.HelmReleasesReady++
		}
	}
	return g, nil
}

func isReady(conds []struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}) bool {
	for _, c := range conds {
		if c.Type == "Ready" {
			return c.Status == "True"
		}
	}
	return false
}

func (k *kubeClient) fluxGET(ctx context.Context, path string) (*fluxList, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, k.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	resp, err := k.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("kube API %s: HTTP %d", path, resp.StatusCode)
	}
	var list fluxList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("kube API %s: %w", path, err)
	}
	return &list, nil
}
