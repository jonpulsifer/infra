package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// testPool wires a pool against a fake GitHub client and a fake launcher —
// no KVM, no network, no real binaries — with one class, "skiff-test",
// warm=1, pointed at a minimal on-disk hull.
func testPool(t *testing.T) (*pool, *fakeGitHub, *fakeLaunch) {
	t.Helper()
	dir := t.TempDir()
	hullDir := writeTestHull(t, dir, "hull", nil)
	cfg := &Config{
		Repo:       "acme/widgets",
		RuntimeDir: filepath.Join(dir, "run"),
		LogDir:     filepath.Join(dir, "log"),
		Classes: map[string]Class{
			"skiff-test": {Hull: hullDir, VCPUs: 1, Memory: "512M", Warm: 1, MaxLifetime: Duration(time.Hour)},
		},
	}
	if err := os.MkdirAll(cfg.RuntimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(cfg.LogDir, 0o755); err != nil {
		t.Fatal(err)
	}

	gh := newFakeGitHub()
	fl := &fakeLaunch{}
	return newPool(cfg, gh, fl, testLogger()), gh, fl
}

func onlySkiff(t *testing.T, p *pool) *skiff {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.skiffs) != 1 {
		t.Fatalf("want exactly 1 skiff, got %d", len(p.skiffs))
	}
	for _, s := range p.skiffs {
		return s
	}
	return nil
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", what)
}

func TestFillBootsWarmCountAndCredentialShareAlwaysPresent(t *testing.T) {
	p, gh, fl := testPool(t)
	ctx := context.Background()

	p.fill(ctx)

	s := onlySkiff(t, p)
	if s.runnerID == 0 {
		t.Fatal("skiff has no runner id")
	}
	if len(gh.generated) != 1 || gh.generated[0].labels[0] != "skiff-test" {
		t.Fatalf("unexpected jitconfig generation: %v", gh.generated)
	}

	// virtiofsd (credential) + passt + cloud-hypervisor, no hull devices.
	if fl.count() != 3 {
		t.Fatalf("want 3 launches for a device-less hull, got %d", fl.count())
	}
	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	found := false
	for i, a := range chCall.args {
		if a == "--fs" && i+1 < len(chCall.args) && chCall.args[i+1] == "tag=bosun,socket="+s.paths.credSock {
			found = true
		}
	}
	if !found {
		t.Fatalf("credential share missing from cloud-hypervisor argv: %v", chCall.args)
	}
}

// Every side-car must be Wait()ed by someone, or it becomes a zombie in
// bosun's process table the moment it exits — one per helper per recycled
// skiff, for as long as bosun runs.
func TestEveryHelperIsReaped(t *testing.T) {
	p, _, fl := testPool(t)
	p.fill(context.Background())

	for _, call := range fl.all() {
		if call.name == "cloud-hypervisor" {
			continue // awaitExit owns this one
		}
		waitFor(t, "helper "+call.name+" is Wait()ed", call.proc.waited.Load)
	}
}

func TestPoolReplacesSkiffAfterExit(t *testing.T) {
	p, _, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p.fill(ctx)
	first := onlySkiff(t, p)

	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	chCall.proc.exit(nil) // guest ran poweroff -f

	waitFor(t, "pool refills after a skiff exits", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		if len(p.skiffs) != 1 {
			return false
		}
		for id := range p.skiffs {
			return id != first.id
		}
		return false
	})

	if _, err := os.Stat(first.paths.dir); !os.IsNotExist(err) {
		t.Fatalf("retired skiff's state dir should be gone, err=%v", err)
	}
}

func TestPoolDoesNotRefillDuringShutdown(t *testing.T) {
	p, _, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())

	p.fill(ctx)
	chCall, _ := fl.last("cloud-hypervisor")

	cancel() // shutting down before the guest exits
	chCall.proc.exit(nil)

	waitFor(t, "retired skiff removed without a replacement", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.skiffs) == 0
	})

	time.Sleep(20 * time.Millisecond) // give a wrongly-spawned replacement a chance to appear
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.skiffs) != 0 {
		t.Fatalf("pool refilled during shutdown: %d skiffs", len(p.skiffs))
	}
}

func TestJITConfigDeletedOnFirstOnline(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.fill(ctx)
	s := onlySkiff(t, p)

	jitPath := filepath.Join(s.paths.dir, "jitconfig")
	if _, err := os.Stat(jitPath); err != nil {
		t.Fatalf("jitconfig should exist before online: %v", err)
	}

	p.pollOnce(ctx) // still offline
	if _, err := os.Stat(jitPath); err != nil {
		t.Fatalf("jitconfig should still exist while offline: %v", err)
	}

	gh.setStatus(s.runnerID, "online", false)
	p.pollOnce(ctx)
	if _, err := os.Stat(jitPath); !os.IsNotExist(err) {
		t.Fatalf("jitconfig should be deleted after first online, err=%v", err)
	}

	p.pollOnce(ctx) // still online: must not error or re-delete
	if _, err := os.Stat(jitPath); !os.IsNotExist(err) {
		t.Fatalf("jitconfig should remain deleted, err=%v", err)
	}
}

// TestWedgedGuestIsKilled drives the wedge path (online, then offline while
// the VMM is still alive) and observes its effect the same way
// TestPoolReplacesSkiffAfterExit does: the skiff gets replaced. It
// deliberately does not read chCall.proc.exitCh directly — awaitExit's own
// goroutine is already receiving from that channel via Wait(), and a second
// receiver would race it for the single buffered value.
func TestWedgedGuestIsKilled(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.fill(ctx)
	first := onlySkiff(t, p)

	gh.setStatus(first.runnerID, "online", true)
	p.pollOnce(ctx) // connects, goes busy

	gh.setStatus(first.runnerID, "offline", true)
	for i := 0; i < wedgeThreshold; i++ {
		p.pollOnce(ctx) // wedge: offline after having been online, repeatedly
	}

	waitFor(t, "wedged skiff is killed and replaced", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		if len(p.skiffs) != 1 {
			return false
		}
		for id := range p.skiffs {
			return id != first.id
		}
		return false
	})
}

func TestSweepRemovesStaleStateAndDeletesRunners(t *testing.T) {
	dir := t.TempDir()
	runtimeDir := filepath.Join(dir, "run")
	staleDir := filepath.Join(runtimeDir, "abc123")
	if err := os.MkdirAll(staleDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(staleDir, "runner-id"), "42")
	writeFile(t, filepath.Join(staleDir, "jitconfig"), "stale")
	writeFile(t, filepath.Join(runtimeDir, "abc123.fs"), "") // stray socket file, no directory

	cfg := &Config{Repo: "acme/widgets", RuntimeDir: runtimeDir, LogDir: filepath.Join(dir, "log")}
	gh := newFakeGitHub()
	gh.statuses[42] = fakeRunnerStatus{status: "offline"}
	p := newPool(cfg, gh, &fakeLaunch{}, testLogger())

	if err := p.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	if _, err := os.Stat(staleDir); !os.IsNotExist(err) {
		t.Fatalf("stale dir should be gone, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(runtimeDir, "abc123.fs")); !os.IsNotExist(err) {
		t.Fatalf("stray socket file should be gone, err=%v", err)
	}
	if len(gh.deleted) != 1 || gh.deleted[0] != 42 {
		t.Fatalf("expected DeleteRunner(42), got %v", gh.deleted)
	}
}

func TestSweepOnEmptyRuntimeDirIsANoop(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{Repo: "acme/widgets", RuntimeDir: filepath.Join(dir, "run"), LogDir: filepath.Join(dir, "log")}
	gh := newFakeGitHub()
	p := newPool(cfg, gh, &fakeLaunch{}, testLogger())

	if err := p.sweep(context.Background()); err != nil {
		t.Fatalf("sweep on fresh runtime dir: %v", err)
	}
	if len(gh.deleted) != 0 {
		t.Fatalf("expected no deletes, got %v", gh.deleted)
	}
}

// TestTransientOfflineDoesNotKill covers the incident this debounce exists for:
// a runner briefly lost its connection to GitHub, and killing on the first
// offline observation destroyed a healthy skiff a minute later. Anything short
// of wedgeThreshold consecutive observations, or a streak broken by a single
// online, must leave the skiff alone -- it may be running a job.
func TestTransientOfflineDoesNotKill(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.fill(ctx)
	first := onlySkiff(t, p)

	gh.setStatus(first.runnerID, "online", true)
	p.pollOnce(ctx)

	for i := 0; i < wedgeThreshold-1; i++ {
		gh.setStatus(first.runnerID, "offline", true)
		p.pollOnce(ctx)
	}
	// one good observation resets the streak, exactly as a reconnect would
	gh.setStatus(first.runnerID, "online", true)
	p.pollOnce(ctx)
	for i := 0; i < wedgeThreshold-1; i++ {
		gh.setStatus(first.runnerID, "offline", true)
		p.pollOnce(ctx)
	}

	p.mu.Lock()
	_, stillThere := p.skiffs[first.id]
	n := len(p.skiffs)
	p.mu.Unlock()
	if !stillThere || n != 1 {
		t.Fatalf("a skiff that never hit %d consecutive offline polls was killed anyway (present=%v, pool=%d)", wedgeThreshold, stillThere, n)
	}
}
