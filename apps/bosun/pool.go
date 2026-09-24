package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// skiff is one running microVM. The poll loop, drain and awaitExit reach the
// state under mu from different goroutines, so only through its methods.
type skiff struct {
	id       string
	class    string
	runnerID int64
	paths    skiffPaths
	slot     int       // workspace slot held from a persisting class, or -1
	mintedAt time.Time // when the JIT config was minted; its ~1h expiry is measured from here

	mu            sync.Mutex
	everOnline    bool      // true once the runner has reported online at least once
	offlineStreak int       // consecutive offline observations; reset by any other status
	busySince     time.Time // zero until the runner first reports busy; maxLifetime is measured from here
	exitReason    string    // why bosun killed this skiff; empty means the guest halted itself
	deregistered  bool      // drain already deleted the GitHub registration; retire must not again

	helpersLog *os.File
	helpers    []proc // virtiofsd(s) + passt
	ch         proc   // cloud-hypervisor; Wait() on this is "did the job finish"

	// A build skiff runs one claimed build request: no registration to poll or
	// deregister, and awaitExit never replaces it.
	build   bool
	buildID string
	// done closes after retire, when the diag share is safe to read.
	done chan struct{}
}

// observe folds one GitHub reading into the skiff's state. justConnected is
// true only on the runner's first online reading.
func (s *skiff) observe(now time.Time, status string, busy bool) (justConnected bool, offlineStreak int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	justConnected = status == "online" && !s.everOnline
	if justConnected {
		s.everOnline = true
	}
	if status == "offline" {
		s.offlineStreak++
	} else {
		s.offlineStreak = 0
	}
	// Recorded once, so maxLifetime runs from the job's start and warm idle time
	// never eats its budget.
	if busy && s.busySince.IsZero() {
		s.busySince = now
	}
	return justConnected, s.offlineStreak
}

func (s *skiff) streak() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.offlineStreak
}

// busy reports whether GitHub has told bosun this skiff took a job.
func (s *skiff) busy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.busySince.IsZero()
}

func (s *skiff) busyFor(now time.Time) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busySince.IsZero() {
		return 0
	}
	return now.Sub(s.busySince)
}

// Build skiffs only: they are busy from boot, so the class's lifetime budget
// runs from then.
func (s *skiff) markBusyFromBoot() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.busySince = s.mintedAt
}

// verdict returns the reason to end this skiff now, or "" to keep it.
func (s *skiff) verdict(now time.Time, maxLifetime time.Duration, fresh bool) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	// Online once, then offline for wedgeThreshold polls while idle. A hung guest
	// still answers ch-remote ping, so GitHub's view is the only signal.
	case s.busySince.IsZero() && s.everOnline && s.offlineStreak >= wedgeThreshold:
		return exitWedged
	// The only reaper of a busy skiff, wedged or working. It runs from busySince,
	// so warm idle time never counts.
	case !s.busySince.IsZero() && maxLifetime > 0 && now.Sub(s.busySince) > maxLifetime:
		return exitLifetime
	// Needs fresh: after a failed read, a zero busySince may hide a job GitHub
	// handed over while its API was refusing bosun.
	case fresh && s.busySince.IsZero() && now.Sub(s.mintedAt) > jitExpiry:
		return exitJITExpired
	}
	return ""
}

// condemn records why bosun will kill this skiff. The poll loop and drain both
// condemn; the first reason wins and returns true.
func (s *skiff) condemn(reason string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exitReason != "" {
		return false
	}
	s.exitReason = reason
	return true
}

func (s *skiff) reason() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.exitReason
}

// scuttle marks a skiff drain already deregistered, so it exits as drained.
func (s *skiff) scuttle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deregistered = true
	s.exitReason = exitDrained
}

// An idle-scuttled skiff was deregistered first, which proved no job could
// be assigned to it; a build skiff never registered.
func (s *skiff) registered() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.build && !s.deregistered
}

// pool keeps every class at its warm count, replacing each skiff that exits.
type pool struct {
	cfg    *Config
	gh     githubClient
	launch launcher
	logger *slog.Logger
	stats  *metrics
	// In every runner name, so a job's "Set up job" log names the bosun host.
	host string
	// Overridable so tests drive the reaping rules at the shipped durations.
	now func() time.Time

	mu     sync.Mutex
	skiffs map[string]*skiff
	// Held workspace slots per persisting class. Tracked, since a slot is claimed
	// before its skiff exists.
	slots map[string]map[int]struct{}
	// draining refuses new spawns. With booting, it lets drain wait out a refill
	// that raced the stop signal.
	draining bool
	// Per class, skiffs on their way into the map. shortfall counts them, or the
	// top-up double-boots into the gap and settles one over the warm count.
	booting map[string]int
	// The top-up's backoff: consecutive failed spawns, and ticks left to sit out.
	spawnFailures map[string]int
	holdoff       map[string]int
}

// Caps the backoff at 2^6 = 64 ticks, about half an hour at a 30s poll: quiet
// for a broken class, yet a fixed host refills without a restart.
const maxHoldoffShift = 6

func newPool(cfg *Config, gh githubClient, launch launcher, logger *slog.Logger) *pool {
	host, _ := os.Hostname()
	return &pool{
		cfg:           cfg,
		gh:            gh,
		launch:        launch,
		logger:        logger,
		stats:         newMetrics(),
		host:          host,
		now:           time.Now,
		skiffs:        map[string]*skiff{},
		slots:         map[string]map[int]struct{}{},
		booting:       map[string]int{},
		spawnFailures: map[string]int{},
		holdoff:       map[string]int{},
	}
}

func (p *pool) runnerName(id string) string {
	if p.host == "" {
		return "skiff-" + id
	}
	return "skiff-" + p.host + "-" + id
}

// Named for the class and slot, since the image outlives every skiff that
// mounts it.
func workspaceSlotName(className string, slot int) string {
	return fmt.Sprintf("%s-%d.img", className, slot)
}

// claimSlot reserves the lowest free slot. Two replacements spawning at once
// would otherwise read the same free index and share a disk.
func (p *pool) claimSlot(className string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	claimed, ok := p.slots[className]
	if !ok {
		claimed = map[int]struct{}{}
		p.slots[className] = claimed
	}
	for slot := 0; ; slot++ {
		if _, taken := claimed[slot]; !taken {
			claimed[slot] = struct{}{}
			return slot
		}
	}
}

func (p *pool) releaseSlot(className string, slot int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.slots[className], slot)
}

// publish writes the metrics textfile after every pool change and poll tick,
// so its mtime is bosun's heartbeat.
func (p *pool) publish() {
	if p.cfg.MetricsFile == "" {
		return
	}
	live := map[string]poolState{}
	desired := map[string]int{}
	for name, class := range p.cfg.Classes {
		desired[name] = class.Warm
	}
	p.mu.Lock()
	for _, s := range p.skiffs {
		state := live[s.class]
		if s.busy() {
			state.busy++
		} else {
			state.idle++
		}
		live[s.class] = state
	}
	p.mu.Unlock()

	if err := writeTextfile(p.cfg.MetricsFile, p.stats.render(live, desired)); err != nil {
		p.logger.Warn("write metrics", "path", p.cfg.MetricsFile, "error", err)
	}
}

// sweep removes everything under runtimeDir and deletes each GitHub runner it
// names. A cgroup kill skips teardown, so all of it is orphaned.
func (p *pool) sweep(ctx context.Context) error {
	if err := os.MkdirAll(p.cfg.RuntimeDir, 0o755); err != nil {
		return fmt.Errorf("sweep: ensure runtime dir: %w", err)
	}
	entries, err := os.ReadDir(p.cfg.RuntimeDir)
	if err != nil {
		return fmt.Errorf("sweep: reading %s: %w", p.cfg.RuntimeDir, err)
	}
	for _, e := range entries {
		path := filepath.Join(p.cfg.RuntimeDir, e.Name())
		if e.IsDir() {
			if idRaw, err := os.ReadFile(filepath.Join(path, "runner-id")); err == nil {
				if id, perr := strconv.ParseInt(strings.TrimSpace(string(idRaw)), 10, 64); perr == nil {
					if err := p.gh.DeleteRunner(ctx, p.cfg.Repo, id); err != nil && !runnerGone(err) {
						// Keep the id so the next start retries.
						p.logger.Warn("sweep: delete stale runner", "skiff", e.Name(), "runner_id", id, "error", err)
						keepRunnerID(path, id, p.logger)
						continue
					}
				}
			}
		}
		if err := os.RemoveAll(path); err != nil {
			p.logger.Warn("sweep: remove stale state", "path", path, "error", err)
		}
	}
	p.sweepWorkspaces()
	return nil
}

// sweepWorkspaces removes leftover workspace images, which survive reboots,
// except persisting slots below the class's warm count: those hold the cache.
func (p *pool) sweepWorkspaces() {
	entries, err := os.ReadDir(p.cfg.WorkspaceDir)
	if err != nil {
		if !os.IsNotExist(err) {
			p.logger.Warn("sweep: reading workspaces", "path", p.cfg.WorkspaceDir, "error", err)
		}
		return
	}
	keep := map[string]struct{}{}
	for name, class := range p.cfg.Classes {
		if !class.Persist {
			continue
		}
		for slot := 0; slot < class.Warm; slot++ {
			keep[workspaceSlotName(name, slot)] = struct{}{}
		}
	}
	for _, e := range entries {
		if _, ok := keep[e.Name()]; ok {
			continue
		}
		path := filepath.Join(p.cfg.WorkspaceDir, e.Name())
		if err := os.RemoveAll(path); err != nil {
			p.logger.Warn("sweep: remove stale workspace", "path", path, "error", err)
		}
	}
}

// fill boots every class to its warm count and returns how many it booted.
func (p *pool) fill(ctx context.Context) int { return p.bootShortfall(ctx, 0) }

// topUp boots a class's missing skiffs, at most one per tick since spawn
// blocks the poll loop. Without it a failed replacement leaves a class short.
func (p *pool) topUp(ctx context.Context) int { return p.bootShortfall(ctx, 1) }

// perClass caps boots per class; <= 0 means no cap.
func (p *pool) bootShortfall(ctx context.Context, perClass int) int {
	booted := 0
	for _, name := range sortedClasses(p.cfg.Classes) {
		if p.heldBack(name) {
			continue
		}
		short := p.shortfall(name)
		if perClass > 0 && short > perClass {
			short = perClass
		}
		for range short {
			if _, err := p.spawn(ctx, p.runnerBerth(name)); err != nil {
				p.spawnFailed(name) // already logged; the backoff decides when to try again
				break
			}
			p.spawnSucceeded(name)
			booted++
		}
	}
	return booted
}

// heldBack consumes one tick of a class's backoff. Each failed spawn mints a
// registration and leaves a diag directory, so the doubling hold stops churn.
func (p *pool) heldBack(className string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.holdoff[className] <= 0 {
		return false
	}
	p.holdoff[className]--
	return true
}

func (p *pool) spawnFailed(className string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.spawnFailures[className]++
	hold := 1 << min(p.spawnFailures[className], maxHoldoffShift)
	p.holdoff[className] = hold
}

func (p *pool) spawnSucceeded(className string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.spawnFailures, className)
	delete(p.holdoff, className)
}

// Build skiffs in the map are not warm slots, so they do not count. Booting
// ones do, which can delay a top-up by a tick but never overshoots.
func (p *pool) shortfall(className string) int {
	class, ok := p.cfg.Classes[className]
	if !ok {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.draining {
		return 0 // drain stops all replacement
	}
	have := p.booting[className]
	for _, s := range p.skiffs {
		if s.class == className && !s.build {
			have++
		}
	}
	if have >= class.Warm {
		return 0
	}
	return class.Warm - have
}

// reserve and release bracket a skiff on its way into the map, so shortfall
// never reads the gap as a short class.
func (p *pool) reserve(className string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.booting[className]++
}

func (p *pool) release(className string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.booting[className]--; p.booting[className] <= 0 {
		delete(p.booting, className)
	}
}

func sortedClasses(classes map[string]Class) []string {
	names := make([]string, 0, len(classes))
	for name := range classes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// A berth is the job a skiff boots for: a GitHub Actions runner or one
// claimed build. spawn owns the shared sequence; the berth supplies the rest.
type berth struct {
	class string
	// "skiff" or "build skiff", for log lines.
	noun string
	// Logger fields for every line of this spawn.
	fields []any
	// mint runs before a workspace slot is claimed and logs its own failure,
	// since nothing retires a skiff that was never built.
	mint func(ctx context.Context, logger *slog.Logger, id string) error
	// prepare writes the skiff's state directory and logs its own failure; spawn
	// retires the skiff.
	prepare func(logger *slog.Logger, s *skiff, hullDigest string) error
	// Extra fields for the "<noun> booted" line.
	booted func() []any
}

// runnerBerth registers a JIT config minted for this skiff alone; awaitExit
// replaces the skiff when it exits.
func (p *pool) runnerBerth(className string) berth {
	// Set by mint, read by prepare and booted: a berth serves one spawn.
	var runnerID int64
	var jitConfig string
	return berth{
		class: className,
		noun:  "skiff",
		mint: func(ctx context.Context, logger *slog.Logger, id string) error {
			// Mint immediately before boot, never stockpiled: the config expires
			// ~1h from this call, not from when a guest first connects.
			var err error
			runnerID, jitConfig, err = p.gh.GenerateJITConfig(ctx, p.cfg.Repo, p.runnerName(id), []string{className})
			if err != nil {
				// Counted, since a failing mint is how a class loses a warm slot while
				// the top-up hides it.
				p.stats.githubError()
				logger.Error("generate jitconfig", "error", err)
			}
			return err
		},
		prepare: func(logger *slog.Logger, s *skiff, hullDigest string) error {
			s.runnerID = runnerID
			if err := p.writeState(s.paths.dir, runnerID, jitConfig, hullDigest); err != nil {
				logger.Error("write state", "error", err)
				return err
			}
			return nil
		},
		booted: func() []any { return []any{"runner_id", runnerID} },
	}
}

// buildBerth runs one claimed build. It has no GitHub registration to mint,
// poll or deregister.
func (p *pool) buildBerth(claim *buildClaim) berth {
	return berth{
		class:  claim.Class,
		noun:   "build skiff",
		fields: []any{"build_id", claim.ID},
		mint:   func(context.Context, *slog.Logger, string) error { return nil },
		prepare: func(logger *slog.Logger, s *skiff, hullDigest string) error {
			s.build = true
			s.buildID = claim.ID
			s.markBusyFromBoot() // busy by construction; see pollBuildSkiff
			s.done = make(chan struct{})
			if err := p.writeBuildState(s.paths.dir, claim.Request, hullDigest); err != nil {
				logger.Error("write build state", "error", err)
				return err
			}
			return nil
		},
		booted: func() []any { return nil },
	}
}

// spawn boots a skiff and hands it to awaitExit; errors are logged. errDraining
// means nothing ran, so runBuild posts no result and the claim's lease expires.
func (p *pool) spawn(ctx context.Context, b berth) (*skiff, error) {
	// Checked under drain's mutex, so each spawn precedes drain's first scuttle
	// pass or is refused.
	p.mu.Lock()
	if p.draining {
		p.mu.Unlock()
		return nil, errDraining
	}
	p.booting[b.class]++
	p.mu.Unlock()
	defer p.release(b.class)

	// The berth's fields first, so an unknown-class error says which path hit it.
	logger := p.logger.With("class", b.class).With(b.fields...)

	class, ok := p.cfg.Classes[b.class]
	if !ok {
		logger.Error("spawn: unknown class")
		return nil, fmt.Errorf("unknown class %q", b.class)
	}

	id, err := newSkiffID()
	if err != nil {
		logger.Error("generate skiff id", "error", err)
		return nil, err
	}
	logger = logger.With("skiff", id)

	h, err := loadHull(class.Hull)
	if err != nil {
		logger.Error("load hull", "error", err)
		return nil, err
	}

	paths, err := resolvePaths(p.cfg.RuntimeDir, p.cfg.LogDir, id, h.manifest.Devices)
	if err != nil {
		logger.Error("resolve paths", "error", err)
		return nil, err
	}

	if err := b.mint(ctx, logger, id); err != nil {
		return nil, err
	}

	// After the mint: every exit past here goes through retire, which releases
	// the slot. Claimed before a failing mint, it would leak.
	slot := -1
	if class.Workspace != "" {
		if class.Persist {
			slot = p.claimSlot(b.class)
			paths.workspace = filepath.Join(p.cfg.WorkspaceDir, workspaceSlotName(b.class, slot))
			logger = logger.With("workspace_slot", slot)
		} else {
			paths.workspace = filepath.Join(p.cfg.WorkspaceDir, id+".img")
		}
	}
	s := &skiff{id: id, class: b.class, paths: paths, slot: slot, mintedAt: p.now()}

	if err := b.prepare(logger, s, h.digest); err != nil {
		s.condemn(exitBootFailed)
		p.retire(ctx, s, logger)
		return nil, err
	}

	if err := p.boot(s, h, class, logger); err != nil {
		logger.Error("boot", "error", err)
		s.condemn(exitBootFailed)
		p.retire(ctx, s, logger)
		return nil, err
	}

	p.mu.Lock()
	if p.draining {
		// Drain began mid-boot, so the mint may postdate drain's scuttle pass.
		// Retire it; the booting counter keeps drain waiting until that finishes.
		p.mu.Unlock()
		logger.Info("drain: scuttling " + b.noun + " spawned mid-stop")
		s.condemn(exitDrained)
		p.retire(ctx, s, logger)
		return nil, errDraining
	}
	p.skiffs[id] = s
	p.mu.Unlock()

	p.stats.boot(b.class)
	logger.Info(b.noun+" booted", b.booted()...)
	p.publish()
	go p.awaitExit(ctx, s, logger)
	return s, nil
}

// writeState makes runtimeDir/<id>, all of bosun's state for the skiff. /run
// is tmpfs, so a reboot clears it.
func (p *pool) writeState(dir string, runnerID int64, jitConfig, hullDigest string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "jitconfig"), []byte(jitConfig), 0o400); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "runner-id"), []byte(strconv.FormatInt(runnerID, 10)), 0o600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "hull"), []byte(hullDigest), 0o600)
}

// writeBuildState writes request.json and the hull digest. With no runner-id,
// retire and sweep have nothing to deregister.
func (p *pool) writeBuildState(dir string, request json.RawMessage, hullDigest string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "request.json"), request, 0o400); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "hull"), []byte(hullDigest), 0o600)
}

// boot starts the virtiofsds and passt before cloud-hypervisor, which connects
// to their sockets. The caller retires whatever started before a failure.
func (p *pool) boot(s *skiff, h *hull, class Class, logger *slog.Logger) error {
	helpersLog, err := os.OpenFile(filepath.Join(p.cfg.LogDir, s.id+".helpers.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open helpers log: %w", err)
	}
	s.helpersLog = helpersLog

	// Before any helper, so a full disk costs one failed spawn and no processes.
	if s.paths.workspace != "" {
		if err := ensureWorkspace(s.paths.workspace, class.Workspace, class.Persist); err != nil {
			return fmt.Errorf("create workspace disk: %w", err)
		}
	}

	virtiofsd := binPath(p.cfg.Bin.Virtiofsd, "virtiofsd")

	if err := p.startHelper(s, virtiofsd, virtiofsdArgs(s.paths.credSock, s.paths.dir, false)); err != nil {
		return fmt.Errorf("start credential virtiofsd: %w", err)
	}

	// The guest's only writable path to the host. Its root is a tmpfs overlay, so
	// the runner's _diag log would otherwise die with it.
	// ponytail: no quota; job code can fill logDir. Add an XFS project quota if one does.
	if err := os.MkdirAll(s.paths.diagDir, 0o755); err != nil {
		return fmt.Errorf("create diag dir: %w", err)
	}
	if err := p.startHelper(s, virtiofsd, virtiofsdArgs(s.paths.diagSock, s.paths.diagDir, false)); err != nil {
		return fmt.Errorf("start diag virtiofsd: %w", err)
	}

	for i, dev := range h.manifest.Devices {
		if dev.Share == nil {
			continue // a disk rides cloud-hypervisor's own --disk; no helper
		}
		if err := p.startHelper(s, virtiofsd, virtiofsdArgs(s.paths.deviceSocks[i], dev.Share.Host, dev.Share.RO)); err != nil {
			return fmt.Errorf("start device virtiofsd %s: %w", dev.Share.Tag, err)
		}
	}

	if err := p.startHelper(s, binPath(p.cfg.Bin.Passt, "passt"), passtArgs(s.paths.netSock)); err != nil {
		return fmt.Errorf("start passt: %w", err)
	}

	chProc, err := p.launch.Start(binPath(p.cfg.Bin.CloudHypervisor, "cloud-hypervisor"), chArgs(h, class, s.id, s.paths, hostServices{cacheURL: p.cfg.CacheURL, buildkitURL: p.cfg.BuildkitURL}, s.build), helpersLog, helpersLog)
	if err != nil {
		return fmt.Errorf("start cloud-hypervisor: %w", err)
	}
	s.ch = chProc

	return nil
}

// startHelper reaps the helper in the background: only cloud-hypervisor's exit
// is waited on, and an unwaited child stays a zombie.
func (p *pool) startHelper(s *skiff, name string, args []string) error {
	pr, err := p.launch.Start(name, args, s.helpersLog, s.helpersLog)
	if err != nil {
		return err
	}
	s.helpers = append(s.helpers, pr)
	go func() { _ = pr.Wait() }()
	return nil
}

func binPath(override, fallback string) string {
	if override != "" {
		return override
	}
	return fallback
}

// awaitExit waits for cloud-hypervisor to exit. The guest's poweroff -f exits
// the VMM with status 0, so wait(2) is the completion signal.
func (p *pool) awaitExit(ctx context.Context, s *skiff, logger *slog.Logger) {
	err := s.ch.Wait()
	// A non-zero exit with no reason set is a VMM that died unasked, in practice
	// the cgroup OOM killer.
	if err != nil {
		s.condemn(exitKilled)
	}
	logger.Info("skiff halted", "error", err)

	// Reserve the replacement before retire removes this skiff, or the top-up
	// boots a second one into the gap.
	if !s.build {
		p.reserve(s.class)
		defer p.release(s.class)
	}

	p.retire(ctx, s, logger)
	if s.build {
		close(s.done) // runBuild is waiting to read the diag share for a result
		return        // buildLoop decides whether another skiff boots
	}
	if ctx.Err() != nil {
		return // shutting down; do not refill
	}
	// A failure is logged; the next tick's top-up recovers it.
	p.spawn(ctx, p.runnerBerth(s.class))
}

// retire kills what bosun started for s, deregisters its runner and removes
// its files, best effort throughout.
func (p *pool) retire(ctx context.Context, s *skiff, logger *slog.Logger) {
	reason := s.reason()
	if reason == "" {
		reason = exitCompleted // the guest powered itself off at the end of its job
	}
	p.stats.exit(s.class, reason)

	for _, h := range s.helpers {
		killBestEffort(h, logger, "helper")
	}
	killBestEffort(s.ch, logger, "cloud-hypervisor")
	if s.helpersLog != nil {
		s.helpersLog.Close()
	}

	// A context that outlives shutdown: a drain-era retire runs after the run
	// context is cancelled, and a skipped DELETE leaves a ghost registration.
	deregistered := true
	if s.registered() {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		switch err := p.gh.DeleteRunner(dctx, p.cfg.Repo, s.runnerID); {
		case err == nil:
		case runnerGone(err):
			// Routine alone, since GitHub ages out ephemeral registrations, but a run
			// of these against succeeding mints is worth seeing.
			logger.Info("runner already gone", "runner_id", s.runnerID)
		default:
			logger.Warn("delete runner on retire", "runner_id", s.runnerID, "error", err)
			deregistered = false
		}
	}

	// diagDir stays as evidence. The state directory stays too if deregistration
	// failed, since its runner-id is the only record sweep can retry from.
	if deregistered {
		os.RemoveAll(s.paths.dir)
	} else {
		keepRunnerID(s.paths.dir, s.runnerID, logger)
	}
	// An ephemeral workspace holds job-written data a reboot would not free, so it
	// goes. A persisting slot is released for the replacement to mount.
	if s.paths.workspace != "" {
		if s.slot >= 0 {
			p.releaseSlot(s.class, s.slot)
		} else {
			os.Remove(s.paths.workspace)
		}
	}
	// virtiofsd leaves <sock>.pid and passt leaves <sock>.repair; neither removes
	// its own. Removing a name that was never created is a no-op.
	for _, sock := range s.paths.sockets() {
		os.Remove(sock)
		os.Remove(sock + ".pid")
		os.Remove(sock + ".repair")
	}

	p.mu.Lock()
	delete(p.skiffs, s.id)
	p.mu.Unlock()
}

// keepRunnerID leaves only runner-id, for sweep to retry deregistering; the
// jitconfig is a live token. It writes the id, since the directory may be empty.
func keepRunnerID(dir string, runnerID int64, logger *slog.Logger) {
	entries, err := os.ReadDir(dir)
	if err != nil && !os.IsNotExist(err) {
		logger.Warn("keep runner-id: read state dir", "path", dir, "error", err)
		return
	}
	for _, e := range entries {
		if e.Name() == "runner-id" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil {
			logger.Warn("keep runner-id: remove state", "path", filepath.Join(dir, e.Name()), "error", err)
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		logger.Warn("keep runner-id: ensure state dir", "path", dir, "error", err)
		return
	}
	if err := os.WriteFile(filepath.Join(dir, "runner-id"), []byte(strconv.FormatInt(runnerID, 10)), 0o600); err != nil {
		logger.Warn("keep runner-id: write id", "path", dir, "error", err)
	}
}

func killBestEffort(pr proc, logger *slog.Logger, what string) {
	if pr == nil {
		return
	}
	if err := pr.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		logger.Warn("kill "+what, "error", err)
	}
}

// pollLoop polls each skiff's runner every PollInterval. bosun never lists
// runners and never listens.
func (p *pool) pollLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(p.cfg.PollInterval))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.pollOnce(ctx)
		}
	}
}

func (p *pool) pollOnce(ctx context.Context) {
	for _, s := range p.snapshot() {
		p.pollSkiff(ctx, s)
	}
	// Every tick, before the top-up: the mtime is the heartbeat, and the top-up
	// mints against the GitHub that may be slowing this tick.
	p.publish()

	// After the poll: a skiff condemned this tick stays in the map until awaitExit
	// reserves its replacement, so the top-up never boots a second one.
	if n := p.topUp(ctx); n > 0 {
		p.logger.Info("warm pool topped up", "booted", n)
		p.publish() // show the new skiffs now
	}
}

// On the first online reading, jitconfig is deleted host-side; virtiofs passes
// the delete through, so job code in the guest never sees a live credential.
func (p *pool) pollSkiff(ctx context.Context, s *skiff) {
	if s.build {
		p.pollBuildSkiff(s)
		return
	}
	logger := p.logger.With("skiff", s.id, "class", s.class)
	status, busy, err := p.gh.GetRunner(ctx, p.cfg.Repo, s.runnerID)
	if err != nil {
		p.stats.githubError()
		logger.Warn("poll runner status", "error", err)
		// Reap anyway: a busy skiff's budget does not pause for a GitHub outage. With
		// fresh false the expiry rule waits, and the wedge streak does not advance.
		p.reap(s, p.now(), logger, false)
		return
	}

	now := p.now()
	justConnected, _ := s.observe(now, status, busy)
	if justConnected {
		// The poll interval quantizes this, but a hull regression moves it by
		// tens of seconds, which survives the rounding.
		p.stats.online(s.class, now.Sub(s.mintedAt).Seconds())
		if err := os.Remove(filepath.Join(s.paths.dir, "jitconfig")); err != nil && !os.IsNotExist(err) {
			logger.Warn("delete jitconfig", "error", err)
		} else {
			logger.Info("runner online, jitconfig revoked")
		}
	}

	p.reap(s, now, logger, true)
}

// reap kills the skiff if its verdict says to. fresh is false when the GitHub
// read failed; see verdict.
func (p *pool) reap(s *skiff, now time.Time, logger *slog.Logger, fresh bool) {
	switch reason := s.verdict(now, p.maxLifetime(s.class), fresh); reason {
	case exitWedged:
		logger.Warn("wedged guest: went offline with the VMM still alive", "consecutive_polls", s.streak())
		s.condemn(reason)
		killBestEffort(s.ch, logger, "wedged cloud-hypervisor")
	case exitLifetime:
		logger.Info("max lifetime exceeded, recycling", "busy_for", s.busyFor(now))
		s.condemn(reason)
		killBestEffort(s.ch, logger, "expired cloud-hypervisor")
	case exitJITExpired:
		logger.Info("idle past JIT expiry, recycling")
		s.condemn(reason)
		killBestEffort(s.ch, logger, "idle-expired cloud-hypervisor")
	}
}

// A build skiff has no registration, so only its lifetime budget can reap it.
func (p *pool) pollBuildSkiff(s *skiff) {
	now := p.now()
	// fresh is moot: a build skiff is busy from boot, so expiry never applies.
	if s.verdict(now, p.maxLifetime(s.class), true) != exitLifetime {
		return
	}
	logger := p.logger.With("skiff", s.id, "class", s.class, "build_id", s.buildID)
	logger.Info("build max lifetime exceeded, killing", "running_for", s.busyFor(now))
	s.condemn(exitLifetime)
	killBestEffort(s.ch, logger, "expired cloud-hypervisor")
}

// drain empties the pool without failing a running job. ctx is the drain
// budget; at its end the rest are killed here, so each still gets a retire.
func (p *pool) drain(ctx context.Context) {
	p.mu.Lock()
	p.draining = true
	p.mu.Unlock()
	// Last write before exit, so the drained exits reach the textfile.
	defer p.publish()
	p.scuttleIdle(ctx)
	check := time.NewTicker(100 * time.Millisecond)
	defer check.Stop()
	poll := time.NewTicker(time.Duration(p.cfg.PollInterval))
	defer poll.Stop()
	for {
		if p.empty() {
			return
		}
		select {
		case <-ctx.Done():
			p.logger.Warn("drain budget exhausted, killing remaining skiffs")
			p.killRemaining()
			p.awaitEmpty(30 * time.Second)
			return
		case <-poll.C:
			// Busy skiffs still need the lifetime reaper, and the mtime is the heartbeat.
			p.pollOnce(ctx)
			p.scuttleIdle(ctx)
		case <-check.C:
		}
	}
}

func (p *pool) snapshot() []*skiff {
	p.mu.Lock()
	defer p.mu.Unlock()
	skiffs := make([]*skiff, 0, len(p.skiffs))
	for _, s := range p.skiffs {
		skiffs = append(skiffs, s)
	}
	return skiffs
}

func (p *pool) empty() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.skiffs) > 0 {
		return false
	}
	for _, n := range p.booting {
		if n > 0 {
			return false
		}
	}
	return true
}

// scuttleIdle deregisters idle skiffs before killing them: GitHub refuses to
// delete a busy runner, so a successful DELETE proves no job can be assigned.
func (p *pool) scuttleIdle(ctx context.Context) {
	for _, s := range p.snapshot() {
		if s.build {
			// Busy from boot; killRemaining takes it at the deadline.
			continue
		}
		if s.busy() || s.reason() != "" {
			continue
		}
		logger := p.logger.With("skiff", s.id, "class", s.class)
		if err := p.gh.DeleteRunner(ctx, p.cfg.Repo, s.runnerID); err != nil {
			logger.Info("drain: leaving skiff to finish", "error", err)
			continue
		}
		s.scuttle()
		logger.Info("drain: idle skiff scuttled")
		killBestEffort(s.ch, logger, "drained cloud-hypervisor")
	}
}

// killRemaining condemns what the drain budget ran out on: each is a lost job
// or a wedged guest.
func (p *pool) killRemaining() {
	for _, s := range p.snapshot() {
		if !s.condemn(exitDrained) {
			continue
		}
		killBestEffort(s.ch, p.logger.With("skiff", s.id, "class", s.class), "cloud-hypervisor at drain deadline")
	}
}

// awaitEmpty gives pending retires, deregistration included, a bounded window
// before systemd kills the cgroup.
func (p *pool) awaitEmpty(limit time.Duration) {
	deadline := time.Now().Add(limit)
	for !p.empty() && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
}

// Zero for a class missing from the config, which verdict reads as no budget,
// so a class removed under a running skiff never kills its job.
func (p *pool) maxLifetime(className string) time.Duration {
	return time.Duration(p.cfg.Classes[className].MaxLifetime)
}

func newSkiffID() (string, error) {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
