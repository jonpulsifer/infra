package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
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
type skiff struct {
	id       string
	class    string
	runnerID int64
	paths    skiffPaths
	mintedAt time.Time // when the JIT config was minted; its ~1h expiry is measured from here

	mu            sync.Mutex
	everOnline    bool      // true once the runner has reported online at least once
	offlineStreak int       // consecutive offline observations; reset by any other status
	busySince     time.Time // zero until the runner first reports busy; maxLifetime is measured from here

	helpersLog *os.File
	helpers    []proc // virtiofsd(s) + passt
	ch         proc   // cloud-hypervisor; Wait() on this is "did the job finish"
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

	mu     sync.Mutex
	skiffs map[string]*skiff
}

func newPool(cfg *Config, gh githubClient, launch launcher, logger *slog.Logger) *pool {
	return &pool{cfg: cfg, gh: gh, launch: launch, logger: logger, skiffs: map[string]*skiff{}}
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
	return nil
}

// fill boots every class up to its configured warm count.
func (p *pool) fill(ctx context.Context) {
	for name, class := range p.cfg.Classes {
		for i := 0; i < class.Warm; i++ {
			p.spawn(ctx, name)
		}
	}
}

// spawn mints a JIT registration, boots one skiff for className, and hands
// its lifetime off to awaitExit. Errors are logged and swallowed: a single
// failed spawn should not take down the rest of the pool.
func (p *pool) spawn(ctx context.Context, className string) {
	class, ok := p.cfg.Classes[className]
	if !ok {
		p.logger.Error("spawn: unknown class", "class", className)
		return
	}
	logger := p.logger.With("class", className)

	id, err := newSkiffID()
	if err != nil {
		logger.Error("generate skiff id", "error", err)
		return
	}
	logger = logger.With("skiff", id)

	h, err := loadHull(class.Hull)
	if err != nil {
		logger.Error("load hull", "error", err)
		return
	}

	paths, err := resolvePaths(p.cfg.RuntimeDir, p.cfg.LogDir, id, h.manifest.Devices)
	if err != nil {
		logger.Error("resolve paths", "error", err)
		return
	}

	// Mint immediately before boot, never stockpiled: the config expires
	// ~1h from this call, not from when a guest first connects.
	runnerID, jitConfig, err := p.gh.GenerateJITConfig(ctx, p.cfg.Repo, "skiff-"+id, []string{className})
	if err != nil {
		logger.Error("generate jitconfig", "error", err)
		return
	}
	s := &skiff{id: id, class: className, runnerID: runnerID, paths: paths, mintedAt: time.Now()}

	if err := p.writeState(paths.dir, runnerID, jitConfig, h.digest); err != nil {
		logger.Error("write state", "error", err)
		p.retire(ctx, s, logger)
		return
	}

	if err := p.boot(s, h, class, logger); err != nil {
		logger.Error("boot", "error", err)
		p.retire(ctx, s, logger)
		return
	}

	p.mu.Lock()
	p.skiffs[id] = s
	p.mu.Unlock()

	logger.Info("skiff booted", "runner_id", runnerID)
	go p.awaitExit(ctx, s, logger)
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

	virtiofsd := binPath(p.cfg.Bin.Virtiofsd, "virtiofsd")

	if err := p.startHelper(s, virtiofsd, virtiofsdArgs(s.paths.credSock, s.paths.dir, false)); err != nil {
		return fmt.Errorf("start credential virtiofsd: %w", err)
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

	chProc, err := p.launch.Start(binPath(p.cfg.Bin.CloudHypervisor, "cloud-hypervisor"), chArgs(h, class, s.id, s.paths), helpersLog, helpersLog)
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
	logger.Info("skiff halted", "error", err)
	p.retire(ctx, s, logger)
	if ctx.Err() != nil {
		return // shutting down; do not refill
	}
	p.spawn(ctx, s.class)
}

// retire tears down everything bosun started for s: kills the helper
// processes, deletes the GitHub runner registration, and removes its state
// and socket files. Best effort throughout — /run is tmpfs, so anything left
// behind here does not survive a reboot either way.
func (p *pool) retire(ctx context.Context, s *skiff, logger *slog.Logger) {
	for _, h := range s.helpers {
		killBestEffort(h, logger, "helper")
	}
	killBestEffort(s.ch, logger, "cloud-hypervisor")
	if s.helpersLog != nil {
		s.helpersLog.Close()
	}

	if err := p.gh.DeleteRunner(ctx, p.cfg.Repo, s.runnerID); err != nil {
		logger.Warn("delete runner on retire", "runner_id", s.runnerID, "error", err)
	}

	os.RemoveAll(s.paths.dir)
	os.Remove(s.paths.credSock)
	os.Remove(s.paths.netSock)
	os.Remove(s.paths.apiSock)
	for _, sock := range s.paths.deviceSocks {
		os.Remove(sock)
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
	p.mu.Lock()
	snapshot := make([]*skiff, 0, len(p.skiffs))
	for _, s := range p.skiffs {
		snapshot = append(snapshot, s)
	}
	p.mu.Unlock()

	for _, s := range snapshot {
		p.pollSkiff(ctx, s)
	}
}

// pollSkiff reconciles one skiff against GitHub's view of its runner.
//
//   - First online observation: revoke the JIT credential host-side. virtiofs
//     passes the delete through, so it vanishes in-guest with no guest
//     cooperation, and untrusted job code never sees a live credential again.
//   - Offline after having been online: the guest may be wedged. ch-remote ping
//     cannot tell a hung guest from a healthy one — both answer with a live
//     VMM — so GitHub's own view of the runner is the only signal. It takes
//     wedgeThreshold consecutive offline observations, because a runner
//     briefly loses its connection whenever the network hiccups and one
//     observation is not worth killing a job over.
//   - Busy transition: recorded once, so maxLifetime is measured from when
//     the job started, not from boot (which would let warm idle time eat a
//     job's budget).
//   - Idle past jitExpiry: the credential this skiff registered with is now
//     dead and it never connected; recycle it for a fresh one.
func (p *pool) pollSkiff(ctx context.Context, s *skiff) {
	logger := p.logger.With("skiff", s.id, "class", s.class)
	status, busy, err := p.gh.GetRunner(ctx, p.cfg.Repo, s.runnerID)
	if err != nil {
		logger.Warn("poll runner status", "error", err)
		return
	}

	s.mu.Lock()
	justConnected := status == "online" && !s.everOnline
	if justConnected {
		s.everOnline = true
	}
	if status == "offline" {
		s.offlineStreak++
	} else {
		s.offlineStreak = 0
	}
	offlineStreak := s.offlineStreak
	if busy && s.busySince.IsZero() {
		s.busySince = time.Now()
	}
	everOnline := s.everOnline
	busySince := s.busySince
	s.mu.Unlock()

	if justConnected {
		if err := os.Remove(filepath.Join(s.paths.dir, "jitconfig")); err != nil && !os.IsNotExist(err) {
			logger.Warn("delete jitconfig", "error", err)
		} else {
			logger.Info("runner online, jitconfig revoked")
		}
	}

	switch {
	case status == "offline" && everOnline && offlineStreak >= wedgeThreshold:
		logger.Warn("wedged guest: went offline with the VMM still alive", "consecutive_polls", offlineStreak)
		killBestEffort(s.ch, logger, "wedged cloud-hypervisor")
	case !busySince.IsZero() && p.exceededLifetime(s.class, busySince):
		logger.Info("max lifetime exceeded, recycling", "busy_for", time.Since(busySince))
		killBestEffort(s.ch, logger, "expired cloud-hypervisor")
	case busySince.IsZero() && time.Since(s.mintedAt) > jitExpiry:
		logger.Info("idle past JIT expiry, recycling")
		killBestEffort(s.ch, logger, "idle-expired cloud-hypervisor")
	}
}

func (p *pool) exceededLifetime(className string, busySince time.Time) bool {
	class, ok := p.cfg.Classes[className]
	if !ok || class.MaxLifetime == 0 {
		return false
	}
	return time.Since(busySince) > time.Duration(class.MaxLifetime)
}

func newSkiffID() (string, error) {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
