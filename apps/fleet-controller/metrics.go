package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// Metrics is a Prometheus text exposition without the client library.
type Metrics struct {
	Reconciles       atomic.Int64
	ReconcileErrors  atomic.Int64
	WorkflowsCreated atomic.Int64
	WorkflowsPruned  atomic.Int64
	Retired          atomic.Int64
	WebhookAccepted  atomic.Int64
	WebhookRejected  atomic.Int64

	mu       sync.Mutex
	devices  map[string]int
	lastOK   time.Time
	lastSeen time.Time
}

// NewMetrics makes an empty set.
func NewMetrics() *Metrics { return &Metrics{devices: map[string]int{}} }

// SetDevices records the device count per status.
func (m *Metrics) SetDevices(counts map[string]int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.devices = counts
}

// Reconciled records a pass; ok says whether it ended with no error.
func (m *Metrics) Reconciled(at time.Time, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastSeen = at
	if ok {
		m.lastOK = at
	}
}

// LastOK is the time of the last clean pass.
func (m *Metrics) LastOK() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastOK
}

func (m *Metrics) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	counter := func(name, help string, v int64) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, v)
	}
	counter("fleet_reconciles_total", "Reconcile passes.", m.Reconciles.Load())
	counter("fleet_reconcile_errors_total", "Reconcile passes that ended with an error.", m.ReconcileErrors.Load())
	counter("fleet_workflows_created_total", "Workflows the controller created.", m.WorkflowsCreated.Load())
	counter("fleet_workflows_pruned_total", "Workflows the controller deleted for age.", m.WorkflowsPruned.Load())
	counter("fleet_devices_retired_total", "Devices the controller moved to offline.", m.Retired.Load())
	counter("fleet_webhook_accepted_total", "Webhook calls with a good signature.", m.WebhookAccepted.Load())
	counter("fleet_webhook_rejected_total", "Webhook calls with a bad signature.", m.WebhookRejected.Load())
	fmt.Fprintf(w, "# HELP fleet_devices NetBox devices by status.\n# TYPE fleet_devices gauge\n")
	statuses := make([]string, 0, len(m.devices))
	for s := range m.devices {
		statuses = append(statuses, s)
	}
	sort.Strings(statuses)
	for _, s := range statuses {
		fmt.Fprintf(w, "fleet_devices{status=%q} %d\n", s, m.devices[s])
	}
	fmt.Fprintf(w, "# HELP fleet_last_reconcile_success_timestamp_seconds Unix time of the last clean pass.\n# TYPE fleet_last_reconcile_success_timestamp_seconds gauge\n")
	fmt.Fprintf(w, "fleet_last_reconcile_success_timestamp_seconds %d\n", m.lastOK.Unix())
}

// Audit writes one JSON line per decision on stdout. The field names are the
// fleet contract's: event, site, node, serial, class, status, workflow,
// reason, ts.
func Audit(event, site string, d Device, workflow, reason string) {
	line := map[string]any{
		"event":    event,
		"site":     site,
		"node":     d.Name,
		"serial":   d.Serial,
		"class":    d.Class,
		"status":   d.Status,
		"workflow": workflow,
		"reason":   reason,
		"ts":       timestamp(time.Now()),
	}
	b, err := json.Marshal(line)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stdout, string(b))
}
