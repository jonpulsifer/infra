package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
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
// The goroutines are bounded by the test binary either way. What is deliberately
// not built to close this is a graceful pool shutdown: bosun's real teardown is
// systemd killing the cgroup and sweep-on-start deregistering what is left, so
// a stop path existing only for tests would be machinery the daemon never runs.
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
	ctx := context.Background()

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
	victim := skiffs[0]
	p.retire(ctx, victim, testLogger())
	if _, err := os.Stat(victim.paths.workspace); err != nil {
		t.Fatalf("persisted workspace was deleted on retire: %v", err)
	}
	if got := p.claimSlot("skiff-test"); got != victim.slot {
		t.Errorf("released slot not reused: claimed %d, want %d", got, victim.slot)
	}
}
