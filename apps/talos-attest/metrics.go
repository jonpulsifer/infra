package main

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

var recordStatuses = []string{StatusAttested, StatusQuarantined}

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
	pendings, err := v.Store.Pendings()
	if err != nil {
		return "", err
	}
	// A claim that waits for approval is not a machine record; it is
	// reported under the name the machine claimed, or its serial.
	pendingNames := map[string]bool{}
	for _, p := range pendings {
		name := p.Machine
		if name == "" {
			name = p.Serial
		}
		pendingNames[name] = true
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
		delete(pendingNames, r.Machine)
	}
	pendingSorted := make([]string, 0, len(pendingNames))
	for name := range pendingNames {
		pendingSorted = append(pendingSorted, name)
	}
	sort.Strings(pendingSorted)
	for _, name := range pendingSorted {
		fmt.Fprintf(&b, "talos_attest_machine_status{machine=%q,status=%q} 1\n", name, StatusPending)
	}
	head("talos_attest_record_updated_timestamp_seconds", "gauge", "When each machine's record last changed on this anchor; the newest across anchors is current.")
	for _, r := range recs {
		fmt.Fprintf(&b, "talos_attest_record_updated_timestamp_seconds{machine=%q} %d\n", r.Machine, r.UpdatedAt.Unix())
	}
	for _, p := range pendings {
		name := p.Machine
		if name == "" {
			name = p.Serial
		}
		if pendingNames[name] {
			fmt.Fprintf(&b, "talos_attest_record_updated_timestamp_seconds{machine=%q} %d\n", name, p.UpdatedAt.Unix())
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
	if v.Intake != nil {
		st := v.intakeState(v.Now())
		open, until := 0, int64(0)
		if st.Open {
			open = 1
		}
		if st.OpenUntil != nil {
			until = st.OpenUntil.Unix()
		}
		head("talos_attest_intake_open", "gauge", "1 while the owner's intake window is open on this anchor.")
		fmt.Fprintf(&b, "talos_attest_intake_open{policy=%q} %d\n", st.Policy, open)
		head("talos_attest_intake_open_until_seconds", "gauge", "When the intake window closes, as its file names it; 0 with no file.")
		fmt.Fprintf(&b, "talos_attest_intake_open_until_seconds{policy=%q} %d\n", st.Policy, until)
	}
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
