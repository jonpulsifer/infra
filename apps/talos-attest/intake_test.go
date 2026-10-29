package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The window fails closed: no file, an empty one or one that does not read
// as RFC3339 is closed, and the policy must match.
func TestIntakeWindowFailsClosed(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	w := &IntakeWindow{Path: filepath.Join(t.TempDir(), "intake-open"), Policy: intakePolicyOpen}
	v := &Verifier{Intake: w, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, body := range []string{"", "\n", "tomorrow\n", "2026-10-29 14:00\n"} {
		if err := os.WriteFile(w.Path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, open := v.intakeOpen(now, intakePolicyOpen); open {
			t.Fatalf("%q opened the window", body)
		}
	}
	if err := w.Set(now.Add(time.Hour), now); err != nil {
		t.Fatal(err)
	}
	if until, open := v.intakeOpen(now, intakePolicyOpen); !open || !until.Equal(now.Add(time.Hour)) {
		t.Fatalf("after Set: %v %v", until, open)
	}
	if _, open := v.intakeOpen(now, intakePolicyDeclared); open {
		t.Fatal("an open-policy window opened under declared")
	}
	if _, open := v.intakeOpen(now.Add(time.Hour), intakePolicyOpen); open {
		t.Fatal("the window is open at its close")
	}
	if err := w.Set(time.Time{}, now); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(w.Path); !os.IsNotExist(err) {
		t.Fatalf("closing left the file: %v", err)
	}
	if err := w.Set(time.Time{}, now); err != nil {
		t.Fatalf("closing a closed window: %v", err)
	}
	if (&Verifier{}).intakeState(now).Open {
		t.Fatal("no window configured reads as open")
	}
}

// The window stays open at most a day: a later close time in the file is
// clamped to a day after it was written, and POST /intake to a day from
// now, and each clamp is journaled.
func TestIntakeWindowIsCappedAtADay(t *testing.T) {
	dir := t.TempDir()
	store, err := OpenStore(filepath.Join(dir, "state"))
	if err != nil {
		t.Fatal(err)
	}
	w := &IntakeWindow{Path: filepath.Join(dir, "intake-open"), Policy: intakePolicyOpen}
	v := &Verifier{Intake: w, Store: store, Now: time.Now, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	written := time.Now()
	if err := os.WriteFile(w.Path, []byte(written.Add(30*24*time.Hour).UTC().Format(time.RFC3339)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		st := v.intakeState(time.Now())
		if !st.Open || st.OpenUntil.After(written.Add(maxIntakeWindow+time.Second)) {
			t.Fatalf("a month-long window: %+v", st)
		}
	}
	srv := &Server{V: v, Log: v.Log, Approvers: map[string]bool{"owner@example.com": true}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/intake", strings.NewReader(`{"open_until":"`+time.Now().Add(48*time.Hour).UTC().Format(time.RFC3339)+`"}`))
	req.Header.Set("Tailscale-User-Login", "owner@example.com")
	srv.Admin().ServeHTTP(rr, req)
	var st IntakeState
	if err := json.Unmarshal(rr.Body.Bytes(), &st); err != nil || rr.Code != http.StatusOK || !st.Open || st.OpenUntil.After(time.Now().Add(maxIntakeWindow)) {
		t.Fatalf("POST /intake for two days: %d %s", rr.Code, rr.Body.String())
	}
	journal, err := os.ReadFile(filepath.Join(dir, "state", "verdicts.jsonl"))
	if err != nil || strings.Count(string(journal), `"event":"attest.intake"`) != 2 {
		t.Fatalf("journal after two clamps: %v\n%s", err, journal)
	}
}
