package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// poolTempDir is t.TempDir() without the cleanup assertion, and the difference
// matters here for one reason: a skiff's lifetime goroutine outlives the test
// that started it. Every test drives the pool with an uncancelled context, so
// awaitExit boots a replacement each time a fake VMM's Wait() resolves — and a
// replacement mid-boot writes into these directories while TempDir is deleting
// them. t.TempDir() reports that as a failed cleanup on a test whose own
// assertions all passed, which is a fault in the harness rather than in bosun.
//
// The goroutines are bounded by the test binary either way. drain is the
// daemon's real stop path, but it is not the answer here: it empties the pool,
// and most of these tests assert on a pool that is deliberately still running.
func poolTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "bosun-pool-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// testPool wires a pool against a fake GitHub client and a fake launcher —
// no KVM, no network, no real binaries — with one class, "skiff-test",
// warm=1, pointed at a minimal on-disk hull.
func testPool(t *testing.T) (*pool, *fakeGitHub, *fakeLaunch) {
	t.Helper()
	dir := poolTempDir(t)
	hullDir := writeTestHull(t, dir, "hull", nil)
	cfg := &Config{
		Repo:         "acme/widgets",
		RuntimeDir:   filepath.Join(dir, "run"),
		LogDir:       filepath.Join(dir, "log"),
		WorkspaceDir: filepath.Join(dir, "workspace"),
		// Real config always has one (LoadConfig defaults it); drain's poll
		// ticker would panic on zero. Short, so drain-path tests retry fast.
		PollInterval: Duration(25 * time.Millisecond),
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

	// virtiofsd (credential) + virtiofsd (diag) + passt + cloud-hypervisor,
	// no hull devices.
	if fl.count() != 4 {
		t.Fatalf("want 4 launches for a device-less hull, got %d", fl.count())
	}
	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	for _, want := range []string{
		"tag=bosun,socket=" + s.paths.credSock,
		"tag=bosun-diag,socket=" + s.paths.diagSock,
	} {
		found := false
		for i, a := range chCall.args {
			if a == "--fs" && i+1 < len(chCall.args) && chCall.args[i+1] == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("share %q missing from cloud-hypervisor argv: %v", want, chCall.args)
		}
	}

	// The diag share is a real host directory, made before the VMM starts:
	// virtiofsd has nothing to serve otherwise.
	if fi, err := os.Stat(s.paths.diagDir); err != nil || !fi.IsDir() {
		t.Fatalf("diag dir not created: err=%v", err)
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
	// The evidence outlives the skiff; that is the entire point of putting it
	// under logDir rather than in the state dir retire wipes.
	if _, err := os.Stat(first.paths.diagDir); err != nil {
		t.Fatalf("retired skiff's diag dir should survive, err=%v", err)
	}
}

// Helpers drop sidecar files beside their sockets and do not clean them up:
// virtiofsd a "<sock>.pid", passt a "<sock>.repair". Removing only the socket
// leaked both for as long as bosun ran.
func TestRetireRemovesHelperSidecarFiles(t *testing.T) {
	p, _, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p.fill(ctx)
	first := onlySkiff(t, p)

	var litter []string
	for _, sock := range first.paths.sockets() {
		for _, path := range []string{sock, sock + ".pid", sock + ".repair"} {
			writeFile(t, path, "")
			litter = append(litter, path)
		}
	}
	if len(litter) == 0 {
		t.Fatal("no sockets to litter: skiffPaths.sockets() returned nothing")
	}

	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	chCall.proc.exit(nil)

	waitFor(t, "retire clears every socket and its sidecars", func() bool {
		for _, path := range litter {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				return false
			}
		}
		return true
	})
}

// A VMM that exits non-zero without bosun having asked was killed by
// something outside -- the cgroup OOM killer is the one that happens. Calling
// that "completed" would hide an OOM-killed job in the metric that says
// whether jobs are finishing.
func TestExternallyKilledSkiffIsNotCountedAsCompleted(t *testing.T) {
	p, _, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p.fill(ctx)
	first := onlySkiff(t, p)

	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	chCall.proc.exit(errors.New("signal: killed"))

	waitFor(t, "exit is recorded as killed", func() bool {
		p.stats.mu.Lock()
		defer p.stats.mu.Unlock()
		return p.stats.exits[first.class][exitKilled] == 1
	})

	p.stats.mu.Lock()
	completed := p.stats.exits[first.class][exitCompleted]
	p.stats.mu.Unlock()
	if completed != 0 {
		t.Fatalf("an externally killed skiff was counted as completed (%d)", completed)
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

// Drain's safety argument, end to end: the registration is deleted before the
// VMM is killed, so GitHub can never hand this skiff a job mid-scuttle — and
// the fake refuses the DELETE for a busy runner exactly as GitHub does, which
// is what makes bosun's own (poll-interval-stale) busy flag irrelevant.
func TestDrainScuttlesIdleSkiffRegistrationFirst(t *testing.T) {
	p, gh, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	p.fill(ctx)
	s := onlySkiff(t, p)
	cancel() // SIGTERM: refills are off

	// The ordering is the safety property, so it is asserted at the moment
	// of the DELETE rather than inferred from the end state: a kill-first
	// scuttle would leave a live registration GitHub could hand a job to.
	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	gh.onDelete = func(int64) {
		if chCall.proc.killed.Load() {
			t.Error("VMM was killed before its registration was deleted")
		}
	}

	done := make(chan struct{})
	go func() { p.drain(context.Background()); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("drain did not return for an all-idle pool")
	}

	if got := gh.deletedIDs(); len(got) != 1 || got[0] != s.runnerID {
		t.Fatalf("want the idle skiff's registration deleted, got %v", got)
	}
	if !p.empty() {
		t.Fatal("pool not empty after drain")
	}
	p.stats.mu.Lock()
	drained := p.stats.exits["skiff-test"][exitDrained]
	p.stats.mu.Unlock()
	if drained != 1 {
		t.Fatalf("idle scuttle not counted as drained: %d", drained)
	}
}

// A busy skiff is left to finish its job: the DELETE is refused, drain waits,
// and the pool empties only when the guest halts itself — counted as
// completed, because the job was.
func TestDrainWaitsForBusySkiffToFinish(t *testing.T) {
	p, gh, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	p.fill(ctx)
	s := onlySkiff(t, p)
	gh.setStatus(s.runnerID, "online", true)
	p.pollOnce(ctx) // bosun observes the job start
	cancel()

	done := make(chan struct{})
	go func() { p.drain(context.Background()); close(done) }()

	time.Sleep(100 * time.Millisecond) // several drain ticks
	select {
	case <-done:
		t.Fatal("drain returned while a job was still running")
	default:
	}

	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	chCall.proc.exit(nil) // the job finished; the guest powered off
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("drain did not return after the busy guest halted")
	}

	p.stats.mu.Lock()
	completed := p.stats.exits["skiff-test"][exitCompleted]
	drained := p.stats.exits["skiff-test"][exitDrained]
	p.stats.mu.Unlock()
	if completed != 1 || drained != 0 {
		t.Fatalf("a job that finished during drain must count as completed, got completed=%d drained=%d", completed, drained)
	}
}

// A refill can race the stop signal: awaitExit's ctx check may pass an
// instant before cancellation, so spawn itself must refuse once drain has
// begun — otherwise a freshly minted skiff joins a pool drain already swept,
// and GitHub can hand it a brand-new job mid-stop.
func TestSpawnRefusesDuringDrain(t *testing.T) {
	p, gh, fl := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	p.fill(ctx)
	s := onlySkiff(t, p)
	gh.setStatus(s.runnerID, "online", true)
	p.pollOnce(ctx) // busy, so drain stays in its wait loop
	cancel()

	done := make(chan struct{})
	go func() { p.drain(context.Background()); close(done) }()
	waitFor(t, "drain marks the pool draining", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return p.draining
	})

	p.spawn(ctx, p.runnerBerth("skiff-test")) // the racing refill
	gh.mu.Lock()
	mints := len(gh.generated)
	gh.mu.Unlock()
	if mints != 1 {
		t.Fatalf("a spawn during drain minted a registration: %d mints", mints)
	}

	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	chCall.proc.exit(nil)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("drain did not return after the busy guest halted")
	}
}

// The drain budget is what bounds how long a stop can block a deploy: at the
// deadline whatever remains is killed and retired, and the loss is visible in
// the exit counter rather than folded into a clean shutdown.
func TestDrainDeadlineKillsRemainingBusySkiff(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	p.fill(ctx)
	s := onlySkiff(t, p)
	gh.setStatus(s.runnerID, "online", true)
	p.pollOnce(ctx)
	cancel()

	drainCtx, dcancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer dcancel()
	p.drain(drainCtx)

	if !p.empty() {
		t.Fatal("pool not empty after the drain deadline")
	}
	p.stats.mu.Lock()
	drained := p.stats.exits["skiff-test"][exitDrained]
	p.stats.mu.Unlock()
	if drained != 1 {
		t.Fatalf("deadline kill not counted as drained: %d", drained)
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

// TestWedgedIdleGuestIsKilled drives the wedge path (online, then offline
// while the VMM is still alive, having never gone busy) and observes its
// effect the same way TestPoolReplacesSkiffAfterExit does: the skiff gets
// replaced. It deliberately does not read chCall.proc.exitCh directly —
// awaitExit's own goroutine is already receiving from that channel via
// Wait(), and a second receiver would race it for the single buffered value.
func TestWedgedIdleGuestIsKilled(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.fill(ctx)
	first := onlySkiff(t, p)

	gh.setStatus(first.runnerID, "online", false)
	p.pollOnce(ctx) // connects, idle

	gh.setStatus(first.runnerID, "offline", false)
	for i := 0; i < wedgeThreshold; i++ {
		p.pollOnce(ctx) // wedge: offline after having been online, repeatedly
	}

	waitFor(t, "wedged idle skiff is killed and replaced", func() bool {
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

// TestWedgeRuleSpareABusySkiff is the reason the rule is scoped to idle
// skiffs at all: the offline-with-a-live-VMM signal cannot distinguish a hung
// guest from a running job whose runner went quiet, and killing on it takes
// the job and the evidence of why. A busy skiff is maxLifetime's problem.
func TestWedgeRuleSparesABusySkiff(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.fill(ctx)
	first := onlySkiff(t, p)

	gh.setStatus(first.runnerID, "online", true)
	p.pollOnce(ctx) // connects and goes busy: a job is running

	gh.setStatus(first.runnerID, "offline", true)
	for i := 0; i < wedgeThreshold*3; i++ {
		p.pollOnce(ctx)
	}

	// The decision, not its effect: pollSkiff sets the exit reason on this
	// goroutine before killing, while retire runs on awaitExit's and would
	// race an assertion about the pool's contents.
	if r := first.reason(); r != "" {
		t.Fatalf("a busy skiff was condemned after %d offline polls, reason=%q", wedgeThreshold*3, r)
	}
	time.Sleep(20 * time.Millisecond) // give a wrongly-scheduled retire a chance to land
	p.mu.Lock()
	_, stillThere := p.skiffs[first.id]
	p.mu.Unlock()
	if !stillThere {
		t.Fatal("a busy skiff was killed by the wedge rule")
	}
}

// The other half of that trade: with the wedge rule declining to act, the
// class's busy-time budget must still reap it, or a wedged job holds its
// label forever.
func TestBusySkiffIsReapedByMaxLifetime(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.cfg.Classes["skiff-test"] = Class{
		Hull:  p.cfg.Classes["skiff-test"].Hull,
		VCPUs: 1, Memory: "512M", Warm: 1,
		MaxLifetime: Duration(time.Millisecond),
	}
	p.fill(ctx)
	first := onlySkiff(t, p)

	gh.setStatus(first.runnerID, "online", true)
	p.pollOnce(ctx) // goes busy; the budget starts here
	time.Sleep(5 * time.Millisecond)

	gh.setStatus(first.runnerID, "offline", true) // wedged, and over budget
	p.pollOnce(ctx)

	waitFor(t, "over-budget busy skiff is killed and replaced", func() bool {
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

// TestTransientOfflineDoesNotKill covers the incident this debounce exists
// for: a runner briefly lost its connection to GitHub, and killing on the
// first offline observation destroyed a healthy skiff a minute later. Driven
// idle, where the wedge rule does apply, so the debounce is what is under
// test rather than the busy exemption. Anything short of wedgeThreshold
// consecutive observations, or a streak broken by a single online, must leave
// the skiff alone.
func TestTransientOfflineDoesNotKill(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	p.fill(ctx)
	first := onlySkiff(t, p)

	gh.setStatus(first.runnerID, "online", false)
	p.pollOnce(ctx)

	for i := 0; i < wedgeThreshold-1; i++ {
		gh.setStatus(first.runnerID, "offline", false)
		p.pollOnce(ctx)
	}
	// one good observation resets the streak, exactly as a reconnect would
	gh.setStatus(first.runnerID, "online", false)
	p.pollOnce(ctx)
	for i := 0; i < wedgeThreshold-1; i++ {
		gh.setStatus(first.runnerID, "offline", false)
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

// A workspace image is reserved on real storage, so unlike everything else a
// skiff leaves behind it does not evaporate with a tmpfs — retire has to
// delete it, and sweep has to collect whatever a cgroup kill left.
func TestWorkspaceDiskIsCreatedOnBootAndDeletedOnRetire(t *testing.T) {
	p, _, fl := testPool(t)
	class := p.cfg.Classes["skiff-test"]
	class.Workspace = "1M"
	p.cfg.Classes["skiff-test"] = class
	ctx := context.Background()

	p.fill(ctx)
	s := onlySkiff(t, p)

	if s.paths.workspace == "" {
		t.Fatal("class sizes a workspace but the skiff got no image path")
	}
	if _, err := os.Stat(s.paths.workspace); err != nil {
		t.Fatalf("workspace image missing after boot: %v", err)
	}
	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	if !slices.Contains(chCall.args, "path="+s.paths.workspace+",readonly=off,image_type=raw") {
		t.Fatalf("workspace disk missing from argv: %v", chCall.args)
	}

	p.retire(ctx, s, testLogger())
	if _, err := os.Stat(s.paths.workspace); !os.IsNotExist(err) {
		t.Fatalf("workspace image survived retire: %v", err)
	}
}

func TestSweepClearsOrphanedWorkspaceImages(t *testing.T) {
	p, _, _ := testPool(t)
	orphan := filepath.Join(p.cfg.WorkspaceDir, "deadbeef.img")
	if err := ensureWorkspace(orphan, "1M", false); err != nil {
		t.Fatalf("ensureWorkspace: %v", err)
	}
	if err := p.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("orphaned workspace survived sweep: %v", err)
	}
}

// bosun restarts on every token rotation and every rebuild of its host. A sweep
// that took the slot images with it would make a warm cache something that only
// ever survives between two consecutive jobs.
func TestSweepKeepsPersistedSlotImagesAndDropsSlotsAboveWarm(t *testing.T) {
	p, _, _ := testPool(t)
	class := p.cfg.Classes["skiff-test"]
	class.Workspace = "1M"
	class.Persist = true
	class.Warm = 2
	p.cfg.Classes["skiff-test"] = class

	live := []string{
		filepath.Join(p.cfg.WorkspaceDir, "skiff-test-0.img"),
		filepath.Join(p.cfg.WorkspaceDir, "skiff-test-1.img"),
	}
	// Slot 2 belongs to a warm count this class no longer declares, so nothing
	// will ever mount it again.
	retired := filepath.Join(p.cfg.WorkspaceDir, "skiff-test-2.img")
	// A skiff whose VMM was killed with the cgroup, from before the class
	// persisted.
	orphan := filepath.Join(p.cfg.WorkspaceDir, "deadbeef.img")
	for _, path := range append(append([]string{}, live...), retired, orphan) {
		if err := ensureWorkspace(path, "1M", false); err != nil {
			t.Fatalf("ensureWorkspace %s: %v", path, err)
		}
	}

	if err := p.sweep(context.Background()); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	for _, path := range live {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("persisted slot image did not survive sweep: %v", err)
		}
	}
	for _, path := range []string{retired, orphan} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("%s survived sweep: %v", filepath.Base(path), err)
		}
	}
}

// Two skiffs finishing at once spawn two replacements on two goroutines. Both
// reading "the lowest free slot" off the live skiff map would hand two running
// guests the same disk, so the claim has to be the reservation.
func TestPersistingClassGivesEachLiveSkiffItsOwnSlotAndHandsItBack(t *testing.T) {
	p, _, fl := testPool(t)
	class := p.cfg.Classes["skiff-test"]
	class.Workspace = "1M"
	class.Persist = true
	class.Warm = 2
	p.cfg.Classes["skiff-test"] = class
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p.fill(ctx)

	p.mu.Lock()
	held := map[string]int{}
	for _, s := range p.skiffs {
		held[filepath.Base(s.paths.workspace)] = s.slot
	}
	skiffs := make([]*skiff, 0, len(p.skiffs))
	for _, s := range p.skiffs {
		skiffs = append(skiffs, s)
	}
	p.mu.Unlock()

	if len(held) != 2 {
		t.Fatalf("two warm skiffs share a workspace image: %v", held)
	}
	for _, want := range []string{"skiff-test-0.img", "skiff-test-1.img"} {
		if _, ok := held[want]; !ok {
			t.Errorf("no skiff mounted %s: %v", want, want)
		}
	}
	if _, ok := fl.last("cloud-hypervisor"); !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}

	// Retire releases the slot rather than deleting the image: what the last
	// job left on it is the cache the next one is here for.
	//
	// Cancelled first, and it is load-bearing. Retiring kills the guest's
	// process, which wakes that skiff's own awaitExit goroutine -- and
	// awaitExit replaces a halted skiff 1:1, so its replacement claims the
	// slot this retire just released. That is the production behaviour and it
	// is correct; it also races the claim below for the same slot, which made
	// this test fail roughly one run in two hundred. awaitExit already skips
	// the replacement once ctx is done, so cancelling is what lets the claim
	// observe the released slot rather than the replacement's.
	cancel()

	victim := skiffs[0]
	p.retire(ctx, victim, testLogger())
	if _, err := os.Stat(victim.paths.workspace); err != nil {
		t.Fatalf("persisted workspace was deleted on retire: %v", err)
	}
	if got := p.claimSlot("skiff-test"); got != victim.slot {
		t.Errorf("released slot not reused: claimed %d, want %d", got, victim.slot)
	}
}

// A build claim boots a skiff the same way a GitHub label does, except the
// share carries request.json instead of a jitconfig and the cmdline tells
// the guest which one to expect.
func TestSpawnBuildBootsSkiffWithRequestJSONAndNoJITConfig(t *testing.T) {
	p, _, fl := testPool(t)
	ctx := context.Background()
	claim := &buildClaim{ID: "build-1", Class: "skiff-test", Request: json.RawMessage(`{"repo":"acme/widgets"}`)}

	s, err := p.spawn(ctx, p.buildBerth(claim))
	if err != nil || s == nil {
		t.Fatalf("spawn: %v", err)
	}
	if !s.build || s.buildID != "build-1" {
		t.Fatalf("skiff not marked as a build skiff: %+v", s)
	}

	got, err := os.ReadFile(filepath.Join(s.paths.dir, "request.json"))
	if err != nil {
		t.Fatalf("request.json missing: %v", err)
	}
	if string(got) != `{"repo":"acme/widgets"}` {
		t.Fatalf("unexpected request.json contents: %s", got)
	}
	if _, err := os.Stat(filepath.Join(s.paths.dir, "jitconfig")); !os.IsNotExist(err) {
		t.Fatalf("build skiff should not have a jitconfig, err=%v", err)
	}

	chCall, ok := fl.last("cloud-hypervisor")
	if !ok {
		t.Fatal("cloud-hypervisor was never launched")
	}
	found := false
	for i, a := range chCall.args {
		if a == "--cmdline" && i+1 < len(chCall.args) && strings.Contains(chCall.args[i+1], "bosun.mode=build") {
			found = true
		}
	}
	if !found {
		t.Fatalf("cmdline missing bosun.mode=build: %v", chCall.args)
	}
}

// The end-to-end path: runBuild boots the skiff, and once it halts the
// result posted to Spindrift is composed from whatever the guest left in the
// diag share -- the same share retire deliberately keeps around.
func TestBuildSkiffExitPostsResultFromDiagFiles(t *testing.T) {
	p, _, fl := testPool(t)
	ctx := context.Background()
	claim := &buildClaim{ID: "build-1", Class: "skiff-test", Request: json.RawMessage(`{}`)}
	sd := &fakeSpindrift{}

	done := make(chan struct{})
	go func() {
		poolBuildSource(p, sd).runBuild(ctx, claim)
		close(done)
	}()

	waitFor(t, "cloud-hypervisor launched for the build skiff", func() bool {
		_, ok := fl.last("cloud-hypervisor")
		return ok
	})
	s := onlySkiff(t, p)

	// Fake the guest: it drops its result into the diag share before halting.
	resultDir := filepath.Join(s.paths.diagDir, "result")
	if err := os.MkdirAll(resultDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(resultDir, "status"), "SUCCEEDED")
	writeFile(t, filepath.Join(resultDir, "build.log"), "build ok\n")

	chCall, _ := fl.last("cloud-hypervisor")
	chCall.proc.exit(nil)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runBuild did not return after the build skiff halted")
	}

	results := sd.postedResults()
	if len(results) != 1 {
		t.Fatalf("want 1 posted result, got %d", len(results))
	}
	if results[0].id != "build-1" || results[0].res.Status != buildSucceeded || results[0].res.Log != "build ok\n" {
		t.Fatalf("unexpected posted result: %+v", results[0])
	}
}

// A guest that halts without ever writing a result -- crashed before it
// could, or the hull does not understand bosun.mode=build at all -- must not
// leave Spindrift's build row hanging until its lease expires.
func TestBuildSkiffExitWithNoResultFilesPostsFailed(t *testing.T) {
	p, _, fl := testPool(t)
	ctx := context.Background()
	claim := &buildClaim{ID: "build-2", Class: "skiff-test", Request: json.RawMessage(`{}`)}
	sd := &fakeSpindrift{}

	done := make(chan struct{})
	go func() {
		poolBuildSource(p, sd).runBuild(ctx, claim)
		close(done)
	}()

	waitFor(t, "cloud-hypervisor launched for the build skiff", func() bool {
		_, ok := fl.last("cloud-hypervisor")
		return ok
	})
	chCall, _ := fl.last("cloud-hypervisor")
	chCall.proc.exit(nil)

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("runBuild did not return after the build skiff halted")
	}

	results := sd.postedResults()
	if len(results) != 1 || results[0].res.Status != buildFailed {
		t.Fatalf("want a single FAILED result, got %+v", results)
	}
}

// awaitExit's replacement logic is scoped to GitHub skiffs: a build skiff's
// next boot is buildLoop's own claim loop, not an automatic refill.
func TestBuildSkiffExitDoesNotRefillTheClass(t *testing.T) {
	p, _, fl := testPool(t)
	ctx := context.Background()
	claim := &buildClaim{ID: "build-3", Class: "skiff-test", Request: json.RawMessage(`{}`)}
	sd := &fakeSpindrift{}

	go poolBuildSource(p, sd).runBuild(ctx, claim)
	waitFor(t, "cloud-hypervisor launched for the build skiff", func() bool {
		_, ok := fl.last("cloud-hypervisor")
		return ok
	})
	chCall, _ := fl.last("cloud-hypervisor")
	chCall.proc.exit(nil)

	waitFor(t, "build skiff retired", func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		return len(p.skiffs) == 0
	})

	time.Sleep(20 * time.Millisecond) // give a wrongly-spawned replacement a chance to appear
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.skiffs) != 0 {
		t.Fatalf("build skiff exit refilled the class: %d skiffs", len(p.skiffs))
	}
}

// A build skiff has no GitHub registration to prove idle against, and is
// busy by construction, so drain's registration-first scuttle must leave it
// alone entirely -- not even attempt a DeleteRunner call.
func TestDrainDoesNotScuttleAnInFlightBuildSkiffViaScuttleIdle(t *testing.T) {
	p, gh, _ := testPool(t)
	ctx := context.Background()
	claim := &buildClaim{ID: "build-4", Class: "skiff-test", Request: json.RawMessage(`{}`)}

	s, err := p.spawn(ctx, p.buildBerth(claim))
	if err != nil || s == nil {
		t.Fatalf("spawn: %v", err)
	}

	p.scuttleIdle(context.Background())

	p.mu.Lock()
	_, stillThere := p.skiffs[s.id]
	p.mu.Unlock()
	if !stillThere {
		t.Fatal("scuttleIdle killed a build skiff, which has no registration to prove idle against")
	}
	if len(gh.deletedIDs()) != 0 {
		t.Fatalf("scuttleIdle called DeleteRunner for a build skiff: %v", gh.deletedIDs())
	}
}

// The wedge and JIT-expiry checks do not apply to a build skiff, but the
// class's lifetime budget still does -- measured from spawn, since a build
// skiff is busy from the moment it boots.
func TestBuildSkiffIsReapedByMaxLifetime(t *testing.T) {
	p, _, _ := testPool(t)
	p.cfg.Classes["skiff-test"] = Class{
		Hull:  p.cfg.Classes["skiff-test"].Hull,
		VCPUs: 1, Memory: "512M", Warm: 0,
		MaxLifetime: Duration(time.Millisecond),
	}
	ctx := context.Background()
	claim := &buildClaim{ID: "build-5", Class: "skiff-test", Request: json.RawMessage(`{}`)}

	s, err := p.spawn(ctx, p.buildBerth(claim))
	if err != nil || s == nil {
		t.Fatalf("spawn: %v", err)
	}
	time.Sleep(5 * time.Millisecond)

	p.pollOnce(ctx)

	if r := s.reason(); r != exitLifetime {
		t.Fatalf("want exitLifetime, got %q", r)
	}
}

// fakeClock drives the pool's now seam. Guarded because a skiff's own
// awaitExit goroutine reads it while the test advances it.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

// TestSkiffVerdict is the reaper at the constants the daemon ships with --
// jitExpiry and a class maxLifetime of an hour, wedgeThreshold of 3 -- rather
// than at the millisecond budgets the pool-level tests have to use to stay
// fast. Each case feeds the skiff its GitHub readings through observe, the
// way pollSkiff does, and then asks for the verdict some time later.
func TestSkiffVerdict(t *testing.T) {
	const maxLifetime = time.Hour
	minted := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)

	type reading struct {
		status string
		busy   bool
	}
	offline := func(n int, busy bool) []reading {
		out := make([]reading, 0, n)
		for i := 0; i < n; i++ {
			out = append(out, reading{"offline", busy})
		}
		return out
	}

	tests := []struct {
		name     string
		readings []reading
		after    time.Duration // when the verdict is taken, measured from the mint
		want     string
	}{
		{
			name:     "an offline streak short of the threshold is a network hiccup",
			readings: append([]reading{{"online", false}}, offline(wedgeThreshold-1, false)...),
			after:    time.Minute,
			want:     "",
		},
		{
			name:     "offline at the threshold, idle, after having been online, is wedged",
			readings: append([]reading{{"online", false}}, offline(wedgeThreshold, false)...),
			after:    time.Minute,
			want:     exitWedged,
		},
		{
			// The same signal on a running job cannot be told from a job whose
			// runner is merely quiet, so the wedge rule spares it.
			name:     "the same signal on a busy skiff is spared",
			readings: append([]reading{{"online", true}}, offline(wedgeThreshold*3, true)...),
			after:    time.Minute,
			want:     "",
		},
		{
			name:     "busy past maxLifetime is over budget",
			readings: []reading{{"online", true}},
			after:    maxLifetime + time.Minute,
			want:     exitLifetime,
		},
		{
			name:     "idle past jitExpiry, never online, is holding a dead credential",
			readings: nil,
			after:    jitExpiry + time.Minute,
			want:     exitJITExpired,
		},
		{
			name:     "never online but still inside jitExpiry is just warm",
			readings: nil,
			after:    jitExpiry - time.Minute,
			want:     "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &skiff{mintedAt: minted}
			for _, r := range tt.readings {
				s.observe(minted, r.status, r.busy)
			}
			if got := s.verdict(minted.Add(tt.after), maxLifetime); got != tt.want {
				t.Fatalf("verdict = %q, want %q", got, tt.want)
			}
		})
	}
}

// A class missing from the config yields a zero budget from pool.maxLifetime,
// and zero must not read as "expired the instant it went busy" — a class going
// missing under a running skiff would then kill the job it is in the middle of.
func TestAZeroBudgetNeverReaps(t *testing.T) {
	minted := time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
	s := &skiff{mintedAt: minted}
	s.observe(minted, "online", true)
	if got := s.verdict(minted.Add(72*time.Hour), 0); got != "" {
		t.Fatalf("verdict = %q, want %q: an absent class has no budget to exceed", got, "")
	}
}

// The budget the daemon actually ships with, driven through the poll loop:
// the clock is the pool's, so an hour of a job passes without the test
// waiting for one or the class having to declare a millisecond budget.
func TestPollSkiffReapsAtTheShippedLifetime(t *testing.T) {
	p, gh, _ := testPool(t)
	clock := &fakeClock{t: time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)}
	p.now = clock.now
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p.fill(ctx)
	first := onlySkiff(t, p)
	if got := p.maxLifetime(first.class); got != time.Hour {
		t.Fatalf("test class budget is %s, want the shipped hour", got)
	}

	gh.setStatus(first.runnerID, "online", true)
	p.pollOnce(ctx) // the job starts; the budget runs from here

	clock.advance(59 * time.Minute)
	p.pollOnce(ctx)
	if r := first.reason(); r != "" {
		t.Fatalf("a skiff inside its budget was condemned: %q", r)
	}

	clock.advance(2 * time.Minute)
	p.pollOnce(ctx)
	if r := first.reason(); r != exitLifetime {
		t.Fatalf("reason = %q, want %q", r, exitLifetime)
	}
}

// A claim that lands just as a stop begins is refused by spawn -- and
// runBuild must post nothing for it: the build was never attempted, so
// staying silent lets Spindrift's lease expire and another host claim the
// request, where a FAILED post would close the build permanently.
func TestDrainRefusedClaimPostsNoResult(t *testing.T) {
	p, _, _ := testPool(t)
	ctx := context.Background()
	claim := &buildClaim{ID: "build-6", Class: "skiff-test", Request: json.RawMessage(`{}`)}
	sd := &fakeSpindrift{}

	p.mu.Lock()
	p.draining = true
	p.mu.Unlock()

	poolBuildSource(p, sd).runBuild(ctx, claim)

	if results := sd.postedResults(); len(results) != 0 {
		t.Fatalf("drain-refused claim posted a result: %+v", results)
	}
}
