package main

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
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
