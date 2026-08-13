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
	"strconv"
	"strings"
	"sync"
	"time"
)

// skiff is one running microVM: its GitHub runner registration, on-disk
// state, and the child processes bosun launched for it.
//
// Everything under mu is the skiff's own state machine — what GitHub has said
// about its runner, and what bosun has decided to do about it. The poll loop,
// the drain path and awaitExit all reach that state from different
// goroutines, so they reach it only through the methods below.
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

	// build marks a skiff spawned for a Spindrift build request rather than a
	// GitHub runner. It carries no registration to poll or deregister, and
	// awaitExit never spawns a replacement for one -- buildLoop's own claim
	// loop is what decides whether another skiff boots.
	build   bool
	buildID string
	// done closes once retire has finished tearing this build skiff down, so
	// runBuild knows it is safe to read the diag share for a result.
	done chan struct{}
}

// observe folds one GitHub reading of this skiff's runner into the state the
// reaping rules read. It reports whether this reading is the runner's first
// online transition — the one observation with a side effect outside the
// skiff — and the consecutive offline count the wedge rule debounces on.
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
	// The busy transition is recorded once, so maxLifetime is measured from
	// when the job started, not from boot (which would let warm idle time eat
	// a job's budget).
	if busy && s.busySince.IsZero() {
		s.busySince = now
	}
	return justConnected, s.offlineStreak
}

// busy reports whether GitHub has told bosun this skiff took a job.
func (s *skiff) busy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.busySince.IsZero()
}

// busyFor is how long this skiff has been on its job, and zero if it never
// took one.
func (s *skiff) busyFor(now time.Time) time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busySince.IsZero() {
		return 0
	}
	return now.Sub(s.busySince)
}

// markBusyFromBoot makes a skiff busy for the whole of its life without a
// GitHub reading behind it. Only a build skiff is: it is busy by
// construction, so its class's lifetime budget runs from the moment it boots
// rather than from a status transition it will never have.
func (s *skiff) markBusyFromBoot() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.busySince = s.mintedAt
}

// verdict answers what, if anything, should end this skiff now: the empty
// string, or the reason to condemn it with.
//
//   - Offline after having been online, and never busy: the guest is wedged
//     holding a credential it will never spend. ch-remote ping cannot tell a
//     hung guest from a healthy one — both answer with a live VMM — so
//     GitHub's own view of the runner is the only signal. It takes
//     wedgeThreshold consecutive offline observations, because a runner
//     briefly loses its connection whenever the network hiccups. (The streak
//     is what says the latest reading was offline: any other status resets
//     it.)
//
//     A skiff that has gone busy is exempt. The same signal on a running job
//     is indistinguishable from a job whose runner is merely quiet, and
//     killing on it destroys the job *and* the evidence of why. maxLifetime
//     is the reaper there: it bounds a wedged busy skiff to the budget its
//     class already declares, which is why that budget may not be zero.
//
//   - Busy past maxLifetime: measured from busySince, never from boot, so
//     warm idle time never eats a job's budget.
//
//   - Idle past jitExpiry: the credential this skiff registered with is now
//     dead and it never connected; recycle it for a fresh one.
func (s *skiff) verdict(now time.Time, maxLifetime time.Duration) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case s.busySince.IsZero() && s.everOnline && s.offlineStreak >= wedgeThreshold:
		return exitWedged
	case !s.busySince.IsZero() && maxLifetime > 0 && now.Sub(s.busySince) > maxLifetime:
		return exitLifetime
	case s.busySince.IsZero() && now.Sub(s.mintedAt) > jitExpiry:
		return exitJITExpired
	}
	return ""
}

// condemn records why bosun is about to kill this skiff and reports whether
// this call is the one that decided it — the poll loop and the drain path
// both condemn, and the first reason wins. awaitExit's retire reads it on
// another goroutine to count the exit.
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

// scuttle records the outcome of drain's registration-first scuttle: the
// GitHub registration is already gone, and the exit belongs to the stop path.
func (s *skiff) scuttle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deregistered = true
	s.exitReason = exitDrained
}

// registered reports whether this skiff still has a GitHub registration for
// retire to delete. An idle-scuttled skiff's was already deleted — first, on
// purpose, because that is what proved no job could land on it — and a build
// skiff never registered with GitHub in the first place.
func (s *skiff) registered() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return !s.build && !s.deregistered
}

// pool keeps every class's warm count full. On start it sweeps stale state
// left by a prior run, then for every skiff that exits — cleanly via the
// guest's own poweroff, or because bosun scuttled it — boots a replacement
// for the same class. There is no dispatch and no inbound connectivity:
// GitHub hands a JIT-registered runner a job unprompted, so bosun's only
// jobs are minting/booting, polling GitHub's view of runner state, and
// noticing when the VMM process exits.
type pool struct {
	cfg    *Config
	gh     githubClient
	launch launcher
	logger *slog.Logger
	stats  *metrics
	// host is baked into every runner's name (skiff-<host>-<id>) so a job's
	// own "Set up job" log says which bosun host to look at.
	host string
	// now is overridable so tests can drive the reaping rules deterministically,
	// at the durations the daemon actually ships with.
	now func() time.Time

	mu     sync.Mutex
	skiffs map[string]*skiff
	// slots is which workspace slot of a persisting class is currently held,
	// per class. Tracked rather than derived from skiffs because a slot is
	// claimed before there is a skiff to derive it from -- see claimSlot.
	slots map[string]map[int]struct{}
	// draining refuses new spawns and, with spawning, lets drain wait out a
	// refill that raced the stop signal: a skiff between mint and map-add is
	// in neither the map nor the process table, and without the counter
	// drain could declare the pool empty while one was mid-boot.
	draining bool
	spawning int
}

func newPool(cfg *Config, gh githubClient, launch launcher, logger *slog.Logger) *pool {
	host, _ := os.Hostname()
	return &pool{
		cfg:    cfg,
		gh:     gh,
		launch: launch,
		logger: logger,
		stats:  newMetrics(),
		host:   host,
		now:    time.Now,
		skiffs: map[string]*skiff{},
		slots:  map[string]map[int]struct{}{},
	}
}

// runnerName is what GitHub shows in a job's "Set up job" header. It carries
// the bosun host because that is the first thing anyone debugging a job needs
// and nothing else in the job log says it.
func (p *pool) runnerName(id string) string {
	if p.host == "" {
		return "skiff-" + id
	}
	return "skiff-" + p.host + "-" + id
}

// workspaceSlotName is the image a persisting class's slot always reuses. Named
// after the class and the slot rather than after a skiff, because the whole
// point is that it outlives every skiff that mounts it.
func workspaceSlotName(className string, slot int) string {
	return fmt.Sprintf("%s-%d.img", className, slot)
}

// claimSlot reserves the lowest free workspace slot for a persisting class.
//
// Reserved rather than computed from the live skiff map, because two skiffs
// finishing at once each spawn a replacement on their own goroutine: both would
// read the same lowest-free index and hand two running guests the same disk.
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

// publish writes the metrics textfile, if one is configured. Called after
// every pool change and on every poll tick, so its mtime doubles as bosun's
// heartbeat.
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

// sweep clears every entry under runtimeDir and deletes the GitHub
// registration for any that had one. A cgroup kill (bosun's own restart, or
// a host reboot before that on tmpfs) leaves no chance to run teardown, so
// whatever is on disk at start is by definition orphaned — there is no
// process left to reconcile against, hence no re-adoption path either.
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
					if err := p.gh.DeleteRunner(ctx, p.cfg.Repo, id); err != nil {
						p.logger.Warn("sweep: delete stale runner", "skiff", e.Name(), "runner_id", id, "error", err)
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

// sweepWorkspaces clears the workspace directory of everything a prior run left
// behind — except the slot images of a class that persists.
//
// Workspace images sit on real storage rather than tmpfs, so unlike per-skiff
// runtime state they survive a reboot as well as a restart, and nothing else
// ever deletes one whose skiff was killed with the cgroup. A persisting class's
// slot images are the exception and the point: they hold the caches the next
// skiff is meant to find, and bosun restarts on every token rotation and every
// rebuild of this host. Throwing them away there would make the warm cache a
// thing that only ever works between two consecutive jobs.
//
// Slots at or above a class's current warm count are *not* kept, so lowering
// warm reclaims the space on the next start rather than leaving images nothing
// will ever mount again.
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

// fill boots every class up to its configured warm count.
func (p *pool) fill(ctx context.Context) {
	for name, class := range p.cfg.Classes {
		for i := 0; i < class.Warm; i++ {
			p.spawn(ctx, p.runnerBerth(name))
		}
	}
}

// A berth is the job a skiff is born to do: crew a GitHub Actions runner, or
// run one claimed Spindrift build. Both births are otherwise the same
// sequence — the draining guard, the class lookup, the id, the hull, the
// paths, the slot claim, boot, and the handoff to awaitExit — so spawn owns
// all of that and the berth supplies only what differs: which class boots,
// what its log lines call it, and the credential or request the guest finds
// in the skiff's state directory.
//
// A struct of funcs rather than an interface with two implementations,
// because the GitHub berth has to carry a minted registration from mint to
// prepare and on into the booted line: closures over the mint's own locals
// say that in a few lines, where an interface would need a struct of the same
// fields behind it.
type berth struct {
	class string
	// noun is what a log line calls this skiff: "skiff" or "build skiff".
	noun string
	// fields are added to the logger for every line this birth writes.
	fields []any
	// mint acquires whatever the job needs from the outside world. It runs
	// before any workspace slot is claimed and logs its own failure, because a
	// failure here returns with no skiff and so no retire to release anything.
	mint func(ctx context.Context, logger *slog.Logger, id string) error
	// prepare stamps the berth onto the constructed skiff and writes its state
	// directory. It logs its own failure; spawn retires the skiff.
	prepare func(logger *slog.Logger, s *skiff, hullDigest string) error
	// booted are the extra fields on the "<noun> booted" line.
	booted func() []any
}

// runnerBerth is a skiff born to crew a GitHub Actions runner for className:
// it registers with a JIT config minted for exactly this skiff, and awaitExit
// replaces it 1:1 when it exits.
func (p *pool) runnerBerth(className string) berth {
	// Minted by mint, spent by prepare and by the booted line: a berth serves
	// exactly one spawn.
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

// buildBerth is a skiff born to run one claimed Spindrift build. It carries no
// GitHub registration: nothing to mint, nothing to poll, and nothing for
// retire or sweep to deregister.
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

// spawn boots one skiff for berth b and hands its lifetime off to awaitExit.
// Errors are logged before they are returned, and fill and awaitExit ignore
// them: a single failed spawn should not take down the rest of the pool.
//
// Returns (nil, errDraining) when a stop is in progress: bosun never ran the
// build, so runBuild must NOT post a result -- staying silent lets the claim's
// lease expire and another host pick the request up, where a FAILED post
// would close the Spindrift build permanently for work nobody attempted. Any
// other nil return is a real setup failure, already logged; runBuild reports
// that one, and Spindrift's lease expiry is not waited on for it.
func (p *pool) spawn(ctx context.Context, b berth) (*skiff, error) {
	// Checked under the same mutex drain sets it under, so every spawn either
	// happens-before drain's first scuttle pass or is refused outright.
	p.mu.Lock()
	if p.draining {
		p.mu.Unlock()
		return nil, errDraining
	}
	p.spawning++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.spawning--
		p.mu.Unlock()
	}()

	// The berth's own fields first, so an unknown class says which birth path
	// hit it: a build claim names one bosun no longer boots, a refill names one
	// removed from the config under a live pool, and they are otherwise the
	// same line.
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

	// Claimed after the mint, because every exit path past this point hands the
	// skiff to retire, which is what releases it. A slot claimed before a
	// failing mint would leak.
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
		// Drain began mid-boot. Anything the berth minted above may postdate
		// drain's scuttle pass, so this skiff must not join the pool: retire
		// deregisters it and kills what boot started, and the spawning
		// counter keeps drain from returning before that finishes.
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

// writeState makes runtimeDir/<id> — bosun's entire state for this skiff.
// /run is tmpfs, so a reboot clears it; there is no database.
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

// writeBuildState is writeState's build-skiff sibling: request.json where a
// GitHub skiff has jitconfig, plus the same hull digest. No runner-id file --
// a build skiff never registers with GitHub, so retire and sweep have
// nothing to deregister for it.
func (p *pool) writeBuildState(dir string, request json.RawMessage, hullDigest string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "request.json"), request, 0o400); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "hull"), []byte(hullDigest), 0o600)
}

// boot starts the credential virtiofsd, one virtiofsd per hull-declared
// device share, passt, and finally cloud-hypervisor — in that order, since
// cloud-hypervisor connects to sockets the others must already be listening
// on. Processes started before a failing step are left running on s for the
// caller to retire.
func (p *pool) boot(s *skiff, h *hull, class Class, logger *slog.Logger) error {
	helpersLog, err := os.OpenFile(filepath.Join(p.cfg.LogDir, s.id+".helpers.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open helpers log: %w", err)
	}
	s.helpersLog = helpersLog

	// Before any helper, so a host that cannot spare the space costs one
	// failed spawn rather than four processes to unwind.
	if s.paths.workspace != "" {
		if err := ensureWorkspace(s.paths.workspace, class.Workspace, class.Persist); err != nil {
			return fmt.Errorf("create workspace disk: %w", err)
		}
	}

	virtiofsd := binPath(p.cfg.Bin.Virtiofsd, "virtiofsd")

	if err := p.startHelper(s, virtiofsd, virtiofsdArgs(s.paths.credSock, s.paths.dir, false)); err != nil {
		return fmt.Errorf("start credential virtiofsd: %w", err)
	}

	// The guest's only writable path onto the host, and the whole reason it
	// exists: a skiff's root is a tmpfs overlay, so a guest that dies mid-job
	// takes the runner's own diagnostic log with it and leaves the serial
	// console — which carries no _diag — as the only evidence.
	//
	// ponytail: no quota. Untrusted job code can fill logDir; the tmpfiles
	// rule in module.nix only ages files out. A loopback filesystem or an
	// XFS project quota is the answer if a job ever does it.
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

// startHelper launches one side-car on s and reaps it in the background.
// bosun's lifecycle signal is cloud-hypervisor's exit alone, so nothing else
// ever Wait()s a helper — and an unwaited child that exits stays a zombie in
// bosun's process table until bosun itself restarts.
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

// awaitExit blocks until the skiff's cloud-hypervisor process exits —
// completion is free: the guest's own "poweroff -f" exits the VMM with
// status 0, so wait(2) is the entire completion signal, whether the guest
// finished on its own or bosun killed it for being wedged or over budget.
func (p *pool) awaitExit(ctx context.Context, s *skiff, logger *slog.Logger) {
	err := s.ch.Wait()
	// A clean guest poweroff exits 0. A non-zero exit with no reason already
	// set means the VMM died without bosun asking -- the cgroup OOM killer is
	// the one that happens -- and calling that "completed" would hide it in
	// the one metric that says whether jobs are finishing.
	if err != nil {
		s.condemn(exitKilled)
	}
	logger.Info("skiff halted", "error", err)
	p.retire(ctx, s, logger)
	if s.build {
		close(s.done) // runBuild is waiting to read the diag share for a result
		return        // buildLoop's own claim loop decides whether another skiff boots
	}
	if ctx.Err() != nil {
		return // shutting down; do not refill
	}
	p.spawn(ctx, p.runnerBerth(s.class))
}

// retire tears down everything bosun started for s: kills the helper
// processes, deletes the GitHub runner registration, and removes its state
// and socket files. Best effort throughout — /run is tmpfs, so anything left
// behind here does not survive a reboot either way.
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

	// Everything still registered deregisters here, on a context that survives
	// shutdown: by the time a drain-era retire runs, the run context is
	// cancelled, and a DELETE that never happens is a ghost registration until
	// the next sweep.
	if s.registered() {
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		if err := p.gh.DeleteRunner(dctx, p.cfg.Repo, s.runnerID); err != nil {
			logger.Warn("delete runner on retire", "runner_id", s.runnerID, "error", err)
		}
	}

	// diagDir is deliberately not removed: it is the evidence, and this is
	// the path a wedged skiff's own death takes.
	os.RemoveAll(s.paths.dir)
	// An ephemeral workspace is removed, and must be — it is the one thing
	// bosun reserves that a reboot would not free, and it is where untrusted
	// job code wrote. A slot from a persisting class is instead handed back for
	// the replacement to mount: what the last job left on it is the cache the
	// next one is here for.
	if s.paths.workspace != "" {
		if s.slot >= 0 {
			p.releaseSlot(s.class, s.slot)
		} else {
			os.Remove(s.paths.workspace)
		}
	}
	// Each helper drops a sidecar file beside its socket -- virtiofsd a
	// "<sock>.pid", passt a "<sock>.repair" -- and neither is cleaned up by
	// the helper on the way out. Removing only the sockets leaked both for as
	// long as bosun ran, since sweep-on-start is what eventually collected
	// them. os.Remove on a name that was never created is a no-op here.
	for _, sock := range s.paths.sockets() {
		os.Remove(sock)
		os.Remove(sock + ".pid")
		os.Remove(sock + ".repair")
	}

	p.mu.Lock()
	delete(p.skiffs, s.id)
	p.mu.Unlock()
}

func killBestEffort(pr proc, logger *slog.Logger, what string) {
	if pr == nil {
		return
	}
	if err := pr.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
		logger.Warn("kill "+what, "error", err)
	}
}

// pollLoop polls every live skiff's GitHub runner status on cfg.PollInterval
// until ctx is cancelled. This is the only inbound-looking traffic bosun
// generates; it never lists runners and never listens for anything.
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
	// Every tick, whether anything changed or not: the file's mtime is the
	// only signal that says bosun is still alive.
	p.publish()
}

// pollSkiff reconciles one skiff against GitHub's view of its runner: read
// the status, fold it in, act on the verdict.
//
// The one thing decided here rather than in the verdict is the first online
// observation, because it is the one with a side effect outside the skiff:
// the JIT credential is revoked host-side. virtiofs passes the delete
// through, so it vanishes in-guest with no guest cooperation, and untrusted
// job code never sees a live credential again.
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
		return
	}

	now := p.now()
	justConnected, offlineStreak := s.observe(now, status, busy)
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

	switch reason := s.verdict(now, p.maxLifetime(s.class)); reason {
	case exitWedged:
		logger.Warn("wedged guest: went offline with the VMM still alive", "consecutive_polls", offlineStreak)
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

// pollBuildSkiff is a build skiff's entire reconciliation: it never
// registers with GitHub, so the wedge and JIT-expiry arms of the verdict
// cannot fire for one — it is busy by construction, from boot rather than
// from a status transition — and the class's lifetime budget every busy
// GitHub skiff is held to is the only thing left to reap it.
func (p *pool) pollBuildSkiff(s *skiff) {
	now := p.now()
	if s.verdict(now, p.maxLifetime(s.class)) != exitLifetime {
		return
	}
	logger := p.logger.With("skiff", s.id, "class", s.class, "build_id", s.buildID)
	logger.Info("build max lifetime exceeded, killing", "running_for", s.busyFor(now))
	s.condemn(exitLifetime)
	killBestEffort(s.ch, logger, "expired cloud-hypervisor")
}

// drain is the stop path: the run context is already cancelled, so awaitExit
// no longer refills, and what remains is emptying the pool without failing a
// running job — the thing a plain stop did twice during the CI migration.
//
// Idle skiffs are scuttled registration-first: GitHub refuses to delete a
// busy runner, so a successful DELETE proves no job can ever land on that
// skiff and its VMM is safe to kill — bosun's own busy flag, up to a poll
// interval stale, never gets a vote. A failed DELETE means the runner is
// busy (the guest finishes its job and halts on its own) or GitHub is
// unreachable (retried next tick).
//
// ctx is the drain budget, not the run context. When it expires, whatever
// remains is killed here rather than left to systemd's cgroup SIGKILL, so
// each skiff still gets a retire and a best-effort deregistration.
func (p *pool) drain(ctx context.Context) {
	p.mu.Lock()
	p.draining = true
	p.mu.Unlock()
	// The last write before the process exits, so the drained exit counter
	// reaches the textfile at all. The next start rewrites the file with
	// fresh counters, so this is best-effort visibility for the scrape that
	// lands in between, not durable accounting.
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
			// Busy skiffs still need the lifetime reaper, and the metrics
			// file's mtime is still the heartbeat.
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
	return len(p.skiffs) == 0 && p.spawning == 0
}

// scuttleIdle deregisters and kills every skiff not known to be busy and not
// already condemned. Known-busy ones are skipped without an API call — the
// DELETE would be refused anyway.
func (p *pool) scuttleIdle(ctx context.Context) {
	for _, s := range p.snapshot() {
		if s.build {
			// No GitHub registration to prove idle against, and busy by
			// construction anyway; killRemaining condemns it at the drain
			// deadline like any other busy skiff.
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

// killRemaining condemns whatever the drain budget ran out on. Every one of
// these is a lost job or a wedged guest; the exit counter says which host and
// class it cost.
func (p *pool) killRemaining() {
	for _, s := range p.snapshot() {
		if !s.condemn(exitDrained) {
			continue
		}
		killBestEffort(s.ch, p.logger.With("skiff", s.id, "class", s.class), "cloud-hypervisor at drain deadline")
	}
}

// awaitEmpty gives the awaitExit goroutines a bounded window to finish their
// retires — deregistration included — before main returns and systemd
// SIGKILLs the cgroup.
func (p *pool) awaitEmpty(limit time.Duration) {
	deadline := time.Now().Add(limit)
	for !p.empty() && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
}

// maxLifetime is the class's busy-time budget — the only thing that reaps a
// busy skiff, wedged or working, so LoadConfig guarantees every class carries
// a non-zero one.
//
// A class that is not in the config at all yields zero, which verdict reads as
// "no budget to exceed" and never reaps on. Zero must not mean "expired the
// instant it went busy": a class going missing under a running skiff would
// then kill the job it is in the middle of.
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
