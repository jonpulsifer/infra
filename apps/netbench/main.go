// netbench is a small web UI for running iperf3 throughput/latency tests
// against a fixed set of configured targets. It is meant to characterise the
// homelab network across three axes:
//
//   - node:          pod -> in-cluster node (inter-node fabric / wire)
//   - lan:           pod -> bare host on another VLAN (inter-LAN routing)
//   - cross-cluster: pod -> remote cluster over the site-to-site tunnel
//
// The browser only ever sends a target *name*; the host/port comes from the
// server-side config, so a client can never point iperf3 at an arbitrary host.
package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"sync"
	"time"
)

//go:embed index.html
var staticFS embed.FS

// Target is a single iperf3 server reachable from this pod.
type Target struct {
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Category    string `json:"category"` // node | lan | cross-cluster
	Description string `json:"description,omitempty"`
}

// Result is the trimmed-down summary we hand back to the browser.
type Result struct {
	Target       string  `json:"target"`
	Host         string  `json:"host"`
	Protocol     string  `json:"protocol"`
	Reverse      bool    `json:"reverse"`
	DurationSecs int     `json:"duration_secs"`
	SendMbps     float64 `json:"send_mbps"`
	RecvMbps     float64 `json:"recv_mbps"`
	JitterMs     float64 `json:"jitter_ms,omitempty"`
	LostPercent  float64 `json:"lost_percent,omitempty"`
	Retransmits  int     `json:"retransmits,omitempty"`
	Error        string  `json:"error,omitempty"`
	RanAt        string  `json:"ran_at"`
}

// iperf3JSON mirrors just the fields of `iperf3 -J` output that we consume.
type iperf3JSON struct {
	Error string `json:"error"`
	End   struct {
		SumSent struct {
			BitsPerSecond float64 `json:"bits_per_second"`
			Retransmits   int     `json:"retransmits"`
		} `json:"sum_sent"`
		SumReceived struct {
			BitsPerSecond float64 `json:"bits_per_second"`
		} `json:"sum_received"`
		// UDP runs report a single "sum" block with loss/jitter instead.
		Sum struct {
			BitsPerSecond float64 `json:"bits_per_second"`
			JitterMs      float64 `json:"jitter_ms"`
			LostPercent   float64 `json:"lost_percent"`
		} `json:"sum"`
	} `json:"end"`
}

type server struct {
	mu      sync.RWMutex
	targets []Target
	iperf3  string // path to the iperf3 binary
}

func main() {
	addr := envOr("NETBENCH_ADDR", ":8080")
	targetsFile := envOr("NETBENCH_TARGETS_FILE", "/etc/netbench/targets.json")

	iperf3Path, err := exec.LookPath("iperf3")
	if err != nil {
		log.Fatalf("iperf3 not found on PATH: %v", err)
	}

	targets, err := loadTargets(targetsFile)
	if err != nil {
		// A missing/empty target file shouldn't keep the UI from starting;
		// it just renders an empty list until the ConfigMap is populated.
		log.Printf("warning: could not load targets from %s: %v", targetsFile, err)
	}
	log.Printf("loaded %d targets from %s", len(targets), targetsFile)

	s := &server{targets: targets, iperf3: iperf3Path}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/api/targets", s.handleTargets)
	mux.HandleFunc("/api/run", s.handleRun)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 120 * time.Second, // long enough for a 60s run + overhead
	}
	log.Printf("netbench listening on %s", addr)
	log.Fatal(srv.ListenAndServe())
}

func (s *server) handleTargets(w http.ResponseWriter, _ *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, http.StatusOK, s.targets)
}

type runRequest struct {
	Target   string `json:"target"`
	Duration int    `json:"duration"`
	Protocol string `json:"protocol"` // tcp | udp
	Reverse  bool   `json:"reverse"`
	Parallel int    `json:"parallel"`
}

func (s *server) handleRun(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	var req runRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}

	target, ok := s.lookup(req.Target)
	if !ok {
		http.Error(w, "unknown target: "+req.Target, http.StatusNotFound)
		return
	}

	duration := clamp(req.Duration, 1, 60, 10)
	parallel := clamp(req.Parallel, 1, 32, 1)
	udp := req.Protocol == "udp"

	result := s.runIperf3(r.Context(), target, duration, parallel, udp, req.Reverse)
	writeJSON(w, http.StatusOK, result)
}

func (s *server) lookup(name string) (Target, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, t := range s.targets {
		if t.Name == name {
			return t, true
		}
	}
	return Target{}, false
}

func (s *server) runIperf3(ctx context.Context, t Target, duration, parallel int, udp, reverse bool) Result {
	res := Result{
		Target:       t.Name,
		Host:         t.Host,
		Protocol:     "tcp",
		Reverse:      reverse,
		DurationSecs: duration,
		RanAt:        time.Now().UTC().Format(time.RFC3339),
	}

	port := t.Port
	if port == 0 {
		port = 5201
	}
	args := []string{
		"-c", t.Host,
		"-p", strconv.Itoa(port),
		"-t", strconv.Itoa(duration),
		"-P", strconv.Itoa(parallel),
		"--connect-timeout", "5000",
		"-J",
	}
	if udp {
		res.Protocol = "udp"
		args = append(args, "-u", "-b", "0") // 0 = saturate the link
	}
	if reverse {
		args = append(args, "-R")
	}

	// Bound the run so a hung connection can't hold the request open forever.
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(duration+15)*time.Second)
	defer cancel()

	out, err := exec.CommandContext(runCtx, s.iperf3, args...).Output()
	if err != nil && len(out) == 0 {
		res.Error = fmt.Sprintf("iperf3 failed: %v", err)
		return res
	}

	var parsed iperf3JSON
	if jerr := json.Unmarshal(out, &parsed); jerr != nil {
		res.Error = fmt.Sprintf("could not parse iperf3 output: %v", jerr)
		return res
	}
	if parsed.Error != "" {
		res.Error = parsed.Error
		return res
	}

	if udp {
		res.SendMbps = bpsToMbps(parsed.End.Sum.BitsPerSecond)
		res.RecvMbps = res.SendMbps
		res.JitterMs = parsed.End.Sum.JitterMs
		res.LostPercent = parsed.End.Sum.LostPercent
	} else {
		res.SendMbps = bpsToMbps(parsed.End.SumSent.BitsPerSecond)
		res.RecvMbps = bpsToMbps(parsed.End.SumReceived.BitsPerSecond)
		res.Retransmits = parsed.End.SumSent.Retransmits
	}
	return res
}

func loadTargets(path string) ([]Target, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var targets []Target
	if err := json.Unmarshal(b, &targets); err != nil {
		return nil, err
	}
	sort.SliceStable(targets, func(i, j int) bool {
		if targets[i].Category != targets[j].Category {
			return targets[i].Category < targets[j].Category
		}
		return targets[i].Name < targets[j].Name
	})
	return targets, nil
}

func bpsToMbps(bps float64) float64 {
	return float64(int64(bps/1e6*100+0.5)) / 100 // round to 2 dp
}

func clamp(v, lo, hi, def int) int {
	if v == 0 {
		return def
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
