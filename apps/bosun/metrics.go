package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Counters only; gauges are read off the live pool at render time.
type metrics struct {
	mu           sync.Mutex
	boots        map[string]int            // class -> skiffs booted
	exits        map[string]map[string]int // class -> reason -> skiffs gone
	onlineSum    map[string]float64        // class -> total mint-to-online seconds
	onlineCount  map[string]int            // class -> skiffs that came online
	ghErrors     int
	buildClaims  int
	buildResults map[string]int // "succeeded"|"failed" -> builds finished
	sdErrors     int
}

// Exit reasons. "completed" means the guest finished its job and powered off.
const (
	exitCompleted  = "completed"
	exitWedged     = "wedged"
	exitLifetime   = "lifetime"
	exitJITExpired = "jit_expired"
	exitBootFailed = "boot_failed"
	// A VMM that died unasked, in practice the cgroup OOM killer: MemoryMax on
	// bosun's unit reaps the biggest guest.
	exitKilled = "killed"
	// Stopped by drain: idle skiffs after deregistration, busy ones only at the
	// drain deadline, which loses their job.
	exitDrained = "drained"
	// A build skiff whose heartbeat was refused (cancelled, or the lease moved),
	// killed so it never pushes an unwanted image.
	exitCancelled = "cancelled"
)

func newMetrics() *metrics {
	return &metrics{
		boots:        map[string]int{},
		exits:        map[string]map[string]int{},
		onlineSum:    map[string]float64{},
		onlineCount:  map[string]int{},
		buildResults: map[string]int{},
	}
}

func (m *metrics) boot(class string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.boots[class]++
}

func (m *metrics) exit(class, reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.exits[class] == nil {
		m.exits[class] = map[string]int{}
	}
	m.exits[class][reason]++
}

// Seconds from JIT mint to GitHub first reporting the runner online.
func (m *metrics) online(class string, seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onlineSum[class] += seconds
	m.onlineCount[class]++
}

func (m *metrics) githubError() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ghErrors++
}

func (m *metrics) buildClaimed() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.buildClaims++
}

// status is buildSucceeded or buildFailed; its lower case is the label.
func (m *metrics) buildResult(status string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.buildResults[strings.ToLower(status)]++
}

func (m *metrics) spindriftError() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sdErrors++
}

// render writes the Prometheus text format by hand. live counts idle and busy
// skiffs per class; desired is each class's warm count.
func (m *metrics) render(live map[string]poolState, desired map[string]int) string {
	m.mu.Lock()
	defer m.mu.Unlock()

	var b strings.Builder
	b.WriteString("# HELP bosun_skiffs Skiffs currently booted, by class and state.\n")
	b.WriteString("# TYPE bosun_skiffs gauge\n")
	for _, class := range sortedKeys(desired) {
		b.WriteString(fmt.Sprintf("bosun_skiffs{class=%q,state=\"idle\"} %d\n", class, live[class].idle))
		b.WriteString(fmt.Sprintf("bosun_skiffs{class=%q,state=\"busy\"} %d\n", class, live[class].busy))
	}

	b.WriteString("# HELP bosun_skiffs_desired Warm skiffs the class is configured to keep.\n")
	b.WriteString("# TYPE bosun_skiffs_desired gauge\n")
	for _, class := range sortedKeys(desired) {
		b.WriteString(fmt.Sprintf("bosun_skiffs_desired{class=%q} %d\n", class, desired[class]))
	}

	b.WriteString("# HELP bosun_skiff_boots_total Skiffs booted since bosun started.\n")
	b.WriteString("# TYPE bosun_skiff_boots_total counter\n")
	for _, class := range sortedKeys(desired) {
		b.WriteString(fmt.Sprintf("bosun_skiff_boots_total{class=%q} %d\n", class, m.boots[class]))
	}

	b.WriteString("# HELP bosun_skiff_exits_total Skiffs gone since bosun started, by why.\n")
	b.WriteString("# TYPE bosun_skiff_exits_total counter\n")
	for _, class := range sortedKeys(desired) {
		for _, reason := range []string{exitCompleted, exitWedged, exitLifetime, exitJITExpired, exitBootFailed, exitKilled, exitDrained} {
			b.WriteString(fmt.Sprintf("bosun_skiff_exits_total{class=%q,reason=%q} %d\n", class, reason, m.exits[class][reason]))
		}
	}

	b.WriteString("# HELP bosun_skiff_time_to_online_seconds Mint-to-online latency; avg = rate(sum)/rate(count).\n")
	b.WriteString("# TYPE bosun_skiff_time_to_online_seconds summary\n")
	for _, class := range sortedKeys(desired) {
		b.WriteString(fmt.Sprintf("bosun_skiff_time_to_online_seconds_sum{class=%q} %g\n", class, m.onlineSum[class]))
		b.WriteString(fmt.Sprintf("bosun_skiff_time_to_online_seconds_count{class=%q} %d\n", class, m.onlineCount[class]))
	}

	b.WriteString("# HELP bosun_github_errors_total GitHub API calls that failed.\n")
	b.WriteString("# TYPE bosun_github_errors_total counter\n")
	b.WriteString(fmt.Sprintf("bosun_github_errors_total %d\n", m.ghErrors))

	b.WriteString("# HELP bosun_build_claims_total Spindrift build requests claimed.\n")
	b.WriteString("# TYPE bosun_build_claims_total counter\n")
	b.WriteString(fmt.Sprintf("bosun_build_claims_total %d\n", m.buildClaims))

	b.WriteString("# HELP bosun_build_results_total Spindrift builds finished, by outcome.\n")
	b.WriteString("# TYPE bosun_build_results_total counter\n")
	for _, status := range []string{"succeeded", "failed"} {
		b.WriteString(fmt.Sprintf("bosun_build_results_total{status=%q} %d\n", status, m.buildResults[status]))
	}

	b.WriteString("# HELP bosun_spindrift_errors_total Spindrift API calls that failed.\n")
	b.WriteString("# TYPE bosun_spindrift_errors_total counter\n")
	b.WriteString(fmt.Sprintf("bosun_spindrift_errors_total %d\n", m.sdErrors))
	return b.String()
}

type poolState struct{ idle, busy int }

// A textfile: skiffs inherit bosun's IPAddressDeny, so a port Prometheus could
// reach would open the pod CIDR to job code. The mtime is the heartbeat.
func writeTextfile(path, body string) error {
	tmp := path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, []byte(body), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
