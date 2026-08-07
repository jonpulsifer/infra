package main

import (
	"errors"
	"os"
	"sync"
	"testing"
)

var errFakeKilled = errors.New("fake: killed")

// fakeProc simulates a running child process without ever exec'ing one.
// exit (test-driven) and Kill (pool-driven) race to resolve the same exit
// channel exactly once, mirroring how a real process can exit on its own or
// be killed from under bosun.
type fakeProc struct {
	exitCh chan error
	once   sync.Once
}

func newFakeProc() *fakeProc {
	return &fakeProc{exitCh: make(chan error, 1)}
}

func (p *fakeProc) Wait() error { return <-p.exitCh }

func (p *fakeProc) Kill() error {
	p.once.Do(func() { p.exitCh <- errFakeKilled })
	return nil
}

// exit simulates the process finishing on its own, e.g. the guest's
// "poweroff -f".
func (p *fakeProc) exit(err error) {
	p.once.Do(func() { p.exitCh <- err })
}

// fakeLaunch records every launch (binary name and argv) instead of
// exec'ing anything, so the boot sequence is testable without KVM.
type fakeLaunch struct {
	mu    sync.Mutex
	calls []fakeCall
}

type fakeCall struct {
	name string
	args []string
	proc *fakeProc
}

func (f *fakeLaunch) Start(name string, args []string, stdout, stderr *os.File) (proc, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p := newFakeProc()
	f.calls = append(f.calls, fakeCall{name: name, args: args, proc: p})
	return p, nil
}

// last returns the most recent call to the named binary.
func (f *fakeLaunch) last(name string) (fakeCall, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].name == name {
			return f.calls[i], true
		}
	}
	return fakeCall{}, false
}

func (f *fakeLaunch) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func TestFakeProcKillThenExitDoesNotBlockOrPanic(t *testing.T) {
	p := newFakeProc()
	if err := p.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}
	p.exit(nil) // must not panic or deadlock even though Kill already resolved it
	if err := p.Wait(); err != errFakeKilled {
		t.Fatalf("Wait: got %v, want errFakeKilled", err)
	}
}
