package main

import (
	"encoding/json"
	"io"
	"sync"
	"time"
)

// Audit writes one JSON line per decision to stdout, the shape every fleet
// service shares so VictoriaLogs can be asked for a serial across them:
// {"event", "site", "node", "serial", "class", "status", "approver",
// "workflow", "reason", "ts"}.
type Audit struct {
	W    io.Writer
	Site string
	Now  func() time.Time
	mu   sync.Mutex
}

// AuditEntry is one line. Event is one of the audit events below.
type AuditEntry struct {
	Event    string `json:"event"`
	Site     string `json:"site"`
	Node     string `json:"node,omitempty"`
	Serial   string `json:"serial,omitempty"`
	Class    string `json:"class,omitempty"`
	Status   string `json:"status,omitempty"`
	Approver string `json:"approver,omitempty"`
	Workflow string `json:"workflow,omitempty"`
	Reason   string `json:"reason,omitempty"`
	TS       string `json:"ts"`
}

// Audit events this service emits.
const (
	auditVerdict = "attest.verdict"
	auditIssue   = "attest.issue"
	auditRenew   = "attest.renew"
	// auditInstall says whether an intake pass got an install code.
	auditInstall = "attest.install"
)

// Emit writes e with the site and the time filled in. A nil Audit is quiet.
func (a *Audit) Emit(e AuditEntry) {
	if a == nil || a.W == nil {
		return
	}
	e.Site = a.Site
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	e.TS = now().UTC().Format(time.RFC3339)
	b, err := json.Marshal(e)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.W.Write(append(b, '\n'))
}
