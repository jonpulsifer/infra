package main

import (
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"testing"
)

var errFakeKilled = errors.New("fake: killed")

// exit (test-driven) and Kill (pool-driven) resolve the same exit channel
// once, as a real process can exit on its own or be killed.
type fakeProc struct {
	exitCh chan error
	once   sync.Once
	waited atomic.Bool // someone is Wait()ing, so this process gets reaped
	killed atomic.Bool // Kill was called; drain tests assert ordering against it
}

func newFakeProc() *fakeProc {
	return &fakeProc{exitCh: make(chan error, 1)}
}

func (p *fakeProc) Wait() error {
	p.waited.Store(true)
	return <-p.exitCh
}

func (p *fakeProc) Kill() error {
	p.killed.Store(true)
	p.once.Do(func() { p.exitCh <- errFakeKilled })
	return nil
}

// exit simulates the guest's own "poweroff -f".
func (p *fakeProc) exit(err error) {
	p.once.Do(func() { p.exitCh <- err })
}

// fakeLaunch records every launch, so the boot sequence is testable without
// KVM.
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

// all returns every recorded call, oldest first.
func (f *fakeLaunch) all() []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeCall(nil), f.calls...)
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
