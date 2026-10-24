package main

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
)

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	pending, approved, served, st := s.Store.Gauges()
	var b strings.Builder
	gauge := func(name, help string, v any) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n%s %v\n", name, help, name, name, v)
	}
	counter := func(name, help string, v uint64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, v)
	}
	labelled := func(name, help, label string, m map[string]uint64) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s counter\n", name, help, name)
		for _, k := range sortedKeys(m) {
			fmt.Fprintf(&b, "%s{%s=%q} %d\n", name, label, k, m[k])
		}
	}

	gauge("talos_enroll_pending", "Enrollments waiting for the owner's approval.", pending)
	gauge("talos_enroll_approved_unfetched", "Approved enrollments whose node has not fetched its config.", approved)
	gauge("talos_enroll_nodes", "Nodes in the machine inputs file.", len(s.Render.Nodes()))
	counter("talos_enroll_device_codes_total", "Device codes issued.", st.DeviceCodes)
	counter("talos_enroll_approvals_total", "Enrollments approved.", st.Approvals)
	counter("talos_enroll_denials_total", "Enrollments denied.", st.Denials)
	counter("talos_enroll_superseded_total", "Enrollments replaced by a newer device request from the same uuid.", st.Superseded)
	counter("talos_enroll_configs_served_total", "Machine configs served.", st.Served)
	labelled("talos_enroll_expired_total", "Device codes and tokens that expired unused.", "kind", st.Expired)
	labelled("talos_enroll_refusals_total", "Requests and approvals refused, by reason.", "reason", st.Refused)
	counter("talos_enroll_notifications_failed_total", "Discord notifications that failed.", s.Out.Failed.Load())
	counter("talos_enroll_notifications_dropped_total", "Discord notifications dropped from a full queue.", s.Out.Dropped.Load())

	b.WriteString("# HELP talos_enroll_config_served_timestamp_seconds When each node last fetched its config.\n")
	b.WriteString("# TYPE talos_enroll_config_served_timestamp_seconds gauge\n")
	nodes := make([]string, 0, len(served))
	for n := range served {
		nodes = append(nodes, n)
	}
	sort.Strings(nodes)
	for _, n := range nodes {
		fmt.Fprintf(&b, "talos_enroll_config_served_timestamp_seconds{node=%q} %d\n", n, served[n].Unix())
	}

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(b.String()))
}

func sortedKeys(m map[string]uint64) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
