package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var recordStatuses = []string{StatusAttested, StatusQuarantined, StatusPending}

// Metrics renders the Prometheus text exposition.
func (v *Verifier) Metrics() (string, error) {
	recs, err := v.Store.Records()
	if err != nil {
		return "", err
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Machine < recs[j].Machine })
	var b strings.Builder
	head := func(name, kind, help string) {
		fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s %s\n", name, help, name, kind)
	}
	head("talos_attest_machine_status", "gauge", "1 for each machine's current attestation status.")
	for _, r := range recs {
		for _, st := range recordStatuses {
			val := 0
			if r.Status == st {
				val = 1
			}
			fmt.Fprintf(&b, "talos_attest_machine_status{machine=%q,status=%q} %d\n", r.Machine, st, val)
		}
	}
	head("talos_attest_last_attested_timestamp_seconds", "gauge", "When each machine last passed attestation.")
	for _, r := range recs {
		if !r.AttestedAt.IsZero() {
			fmt.Fprintf(&b, "talos_attest_last_attested_timestamp_seconds{machine=%q} %d\n", r.Machine, r.AttestedAt.Unix())
		}
	}
	head("talos_attest_ldevid_expiry_timestamp_seconds", "gauge", "When each machine's LDevID certificate expires.")
	for _, r := range recs {
		if r.Issued() && !r.LDevIDNotAfter.IsZero() {
			fmt.Fprintf(&b, "talos_attest_ldevid_expiry_timestamp_seconds{machine=%q} %d\n", r.Machine, r.LDevIDNotAfter.Unix())
		}
	}
	head("talos_attest_verdicts_total", "counter", "Verdicts since the service started, by verdict and reason.")
	counts := v.Verdicts()
	keys := make([][2]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i][0]+keys[i][1] < keys[j][0]+keys[j][1] })
	for _, k := range keys {
		fmt.Fprintf(&b, "talos_attest_verdicts_total{verdict=%q,reason=%q} %d\n", k[0], k[1], counts[k])
	}
	head("talos_attest_ca_expiry_timestamp_seconds", "gauge", "When the DevID CA certificate expires.")
	fmt.Fprintf(&b, "talos_attest_ca_expiry_timestamp_seconds %d\n", v.CA.Cert.NotAfter.Unix())
	return b.String(), nil
}

func (s *Server) metrics(w http.ResponseWriter, _ *http.Request) {
	text, err := s.V.Metrics()
	if err != nil {
		s.writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(text))
}

// WriteMetricsFile writes the exposition for node-exporter's textfile
// collector, through a rename so the collector never reads half a file.
func (v *Verifier) WriteMetricsFile(path string) error {
	text, err := v.Metrics()
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".talos-attest-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(text); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
