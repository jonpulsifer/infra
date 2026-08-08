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
	mu       sync.Mutex
	boots    map[string]int            // class -> skiffs booted
	exits    map[string]map[string]int // class -> reason -> skiffs gone
	ghErrors int
}

// Exit reasons. "completed" is the one that means a job ran: the guest reached
// the end of its single job and powered itself off.
const (
	exitCompleted  = "completed"
	exitWedged     = "wedged"
	exitLifetime   = "lifetime"
	exitJITExpired = "jit_expired"
	exitBootFailed = "boot_failed"
)

func newMetrics() *metrics {
	return &metrics{boots: map[string]int{}, exits: map[string]map[string]int{}}
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

func (m *metrics) githubError() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ghErrors++
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
		for _, reason := range []string{exitCompleted, exitWedged, exitLifetime, exitJITExpired, exitBootFailed} {
			b.WriteString(fmt.Sprintf("bosun_skiff_exits_total{class=%q,reason=%q} %d\n", class, reason, m.exits[class][reason]))
		}
	}

	b.WriteString("# HELP bosun_github_errors_total GitHub API calls that failed.\n")
	b.WriteString("# TYPE bosun_github_errors_total counter\n")
	b.WriteString(fmt.Sprintf("bosun_github_errors_total %d\n", m.ghErrors))
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
