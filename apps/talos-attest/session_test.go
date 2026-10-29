package main

import (
	"testing"
	"time"
)

// A request for the other state's route never removes a session: empty
// evidence posted for a passed session leaves it for the confirm.
func TestTakeSessionLeavesASessionInTheOtherState(t *testing.T) {
	v := &Verifier{Now: time.Now}
	now := time.Now()
	id := v.open(&session{machine: Machine{Name: "testbox"}, expires: now.Add(time.Minute), passed: true, passedAt: now})
	if _, ok := v.takeSession(id, false); ok {
		t.Fatal("an evidence route took a passed session")
	}
	if _, ok := v.takeSession(id, true); !ok {
		t.Fatal("the passed session is gone")
	}
	if _, ok := v.takeSession(id, true); ok {
		t.Fatal("a session was taken twice")
	}
}

// A new start for the same machine drops its older sessions, except a pass
// that waits for its confirm within confirmWindow.
func TestOpenKeepsAPassAwaitingItsConfirm(t *testing.T) {
	now := time.Now()
	v := &Verifier{Now: func() time.Time { return now }}
	m := Machine{Name: "testbox"}
	expires := now.Add(time.Hour)
	waiting := v.open(&session{machine: m, expires: expires, passed: true, passedAt: now.Add(-time.Minute)})
	stale := v.open(&session{machine: Machine{Name: "swell"}, expires: expires, passed: true, passedAt: now.Add(-confirmWindow - time.Second)})
	open := v.open(&session{machine: Machine{Name: "swell"}, expires: expires})
	unpassed := v.open(&session{machine: m, expires: expires})
	v.open(&session{machine: m, expires: expires})
	v.open(&session{machine: Machine{Name: "swell"}, expires: expires})

	for id, want := range map[string]bool{waiting: true, stale: false, open: false, unpassed: false} {
		if _, ok := v.sessions[id]; ok != want {
			t.Errorf("session %s kept %v, want %v", id, ok, want)
		}
	}
}
