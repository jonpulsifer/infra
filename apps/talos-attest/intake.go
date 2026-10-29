package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Intake policies: how a box with no pins on record gets its identity.
const (
	// intakePolicyOpen admits, within the owner's window, a serial NetBox
	// does not know, on its EK certificates, and creates its device.
	intakePolicyOpen = "open"
	// intakePolicyDeclared admits no serial NetBox does not know, window or
	// not: a box passes as the planned stub the owner declared, which the
	// pass binds to.
	intakePolicyDeclared = "declared"
)

// IntakeWindow is the owner's statement that boxes are being racked: a file
// holding the RFC3339 time until which the window is open. It is read again
// on every use, so the owner opens and closes it without a restart.
type IntakeWindow struct {
	Path   string
	Policy string
}

func validIntakePolicy(p string) bool {
	return p == intakePolicyOpen || p == intakePolicyDeclared
}

// Until is the time the file names, zero when there is no file. A file that
// does not read as RFC3339 is an error, and the window is closed.
func (w *IntakeWindow) Until() (time.Time, error) {
	if w == nil || w.Path == "" {
		return time.Time{}, nil
	}
	b, err := os.ReadFile(w.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return time.Time{}, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s: %w", w.Path, err)
	}
	return t, nil
}

// Set opens the window until t, through a rename so a Start never reads
// half a file, or closes it when t is not after now.
func (w *IntakeWindow) Set(t, now time.Time) error {
	if !t.After(now) {
		if err := os.Remove(w.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(w.Path), ".intake-open-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(t.UTC().Format(time.RFC3339) + "\n"); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), w.Path)
}

// IntakeState is the window as GET /intake answers it.
type IntakeState struct {
	Open      bool       `json:"open"`
	OpenUntil *time.Time `json:"open_until"`
	Policy    string     `json:"policy"`
}

// intakeState reads the window now. An unreadable file is logged and reads
// as closed: the window fails closed.
func (v *Verifier) intakeState(now time.Time) IntakeState {
	if v.Intake == nil {
		return IntakeState{}
	}
	st := IntakeState{Policy: v.Intake.Policy}
	until, err := v.Intake.Until()
	if err != nil {
		v.Log.Warn("intake window unreadable; closed", "err", err)
		return st
	}
	if !until.IsZero() {
		st.OpenUntil = &until
		st.Open = now.Before(until)
	}
	return st
}

// intakeOpen is the time an open window closes, and whether it is open now
// under policy.
func (v *Verifier) intakeOpen(now time.Time, policy string) (time.Time, bool) {
	st := v.intakeState(now)
	if !st.Open || st.Policy != policy {
		return time.Time{}, false
	}
	return *st.OpenUntil, true
}

// WatchIntake refreshes the metrics each time the window opens, closes or
// moves, read every interval until ctx ends.
func (v *Verifier) WatchIntake(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	last := v.intakeState(v.Now())
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			st := v.intakeState(v.Now())
			if st.Open != last.Open || !sameTime(st.OpenUntil, last.OpenUntil) {
				v.changed()
			}
			last = st
		}
	}
}

func sameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func (s *Server) intake(w http.ResponseWriter, r *http.Request) {
	if s.V.Intake == nil {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, s.V.intakeState(s.V.Now()))
}

// setIntake opens the window until open_until, or closes it when that is
// empty or past.
func (s *Server) setIntake(w http.ResponseWriter, r *http.Request) {
	if s.V.Intake == nil {
		http.NotFound(w, r)
		return
	}
	var req struct {
		OpenUntil string `json:"open_until"`
	}
	if !decode(w, r, &req) {
		return
	}
	var until time.Time
	if req.OpenUntil != "" {
		t, err := time.Parse(time.RFC3339, req.OpenUntil)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "open_until must be an RFC3339 time: " + err.Error()})
			return
		}
		until = t
	}
	now := s.V.Now()
	if err := s.V.Intake.Set(until, now); err != nil {
		s.writeError(w, err)
		return
	}
	approver := strings.ToLower(r.Header.Get("Tailscale-User-Login"))
	entry := AuditEntry{Event: auditIntake, Status: "closed", Approver: approver, Reason: "policy " + s.V.Intake.Policy}
	if until.After(now) {
		entry.Status, entry.Reason = "opened", "until "+until.UTC().Format(time.RFC3339)+", policy "+s.V.Intake.Policy
	}
	s.Log.Info("intake window "+entry.Status, "until", until, "policy", s.V.Intake.Policy, "approver", approver)
	s.V.Audit.Emit(entry)
	s.V.changed()
	writeJSON(w, http.StatusOK, s.V.intakeState(now))
}
