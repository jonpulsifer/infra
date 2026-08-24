package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// metrics is bosun's counters. Gauges are not kept here -- they are read off
// the live pool at write time, since the running skiffs are the state.
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

// Exit reasons. "completed" is the one that means a job ran: the guest reached
// the end of its single job and powered itself off.
const (
	exitCompleted  = "completed"
	exitWedged     = "wedged"
	exitLifetime   = "lifetime"
	exitJITExpired = "jit_expired"
	exitBootFailed = "boot_failed"
	// exitKilled is a VMM that died without bosun asking. The cgroup OOM
	// killer is the one that happens: every skiff is a child of bosun's unit,
	// so a MemoryMax there reaps the biggest guest rather than letting the
	// host pick a victim. Distinct from "completed" because counting an
	// OOM-killed job as a finished one hides exactly the thing worth alerting
	// on.
	exitKilled = "killed"
	// exitDrained is a skiff scuttled by the stop path: idle ones after their
	// registration was deleted (so no job was lost), busy ones only at the
	// drain deadline (so a job was — which is why the reason is visible in
	// the exit counter rather than folded into "killed").
	exitDrained = "drained"
	// exitCancelled is a build skiff killed because Spindrift stopped
	// answering its heartbeat: the request was cancelled, or its lease was
	// reclaimed by another host. Nothing wants what the guest was making, and
	// left alone it would push a cancelled build's image.
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

// online records how long a skiff took from JIT mint to GitHub first reporting
// its runner online -- boot, registration and connect together. The five
// hand-run benches all measured this edge by stopwatch; recording it makes a
// hull or network regression visible without one.
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

// buildResult records one finished build by outcome. status is always
// buildSucceeded or buildFailed, so lower-casing it is the whole mapping to
// the metric's label.
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

// render writes the Prometheus text exposition format. It is a handful of
// series, so it is built by hand rather than by pulling in a client library.
//
// live counts idle/busy skiffs per class; desired is each class's warm count.
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

// poolState is one class's live skiff count split by whether GitHub has
// reported the runner busy.
type poolState struct{ idle, busy int }

// writeTextfile publishes the metrics for node-exporter's textfile collector.
// A file, not an HTTP listener: bosun's unit carries the IPAddressDeny that
// every skiff inherits, so a socket that in-cluster Prometheus could reach
// would mean opening the pod CIDR to untrusted job code as well.
//
// The write is atomic, and its mtime is the heartbeat -- node-exporter exports
// it as node_textfile_mtime_seconds, so a stale file is how a dead or wedged
// bosun is detected without bosun reporting anything about itself.
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
