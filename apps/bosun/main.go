// bosun keeps a warm pool of "skiffs" — ephemeral cloud-hypervisor microVMs,
// each serving exactly one GitHub Actions job before halting. It is a peer
// of apps/spindrift, not part of it.
//
// A JIT-registered runner is ephemeral by construction: GitHub hands an
// already-booted skiff a matching job unprompted, so bosun never learns a
// job was queued. There is no webhook, no queue listener, and no inbound
// connectivity — bosun boots the configured warm count per class and
// replaces each skiff after it halts. See pool.go for the mint/boot, poll,
// and recycle halves of that loop; hull.go for the contract a hull declares,
// and vmm.go for how that becomes cloud-hypervisor argv.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func main() {
	configPath := flag.String("config", "", "Path to bosun's JSON config file (required)")
	verbose := flag.Bool("verbose", false, "Enable debug logging")
	flag.Parse()

	logLevel := new(slog.LevelVar)
	if *verbose {
		logLevel.Set(slog.LevelDebug)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))

	if *configPath == "" {
		logger.Error("-config is required")
		os.Exit(1)
	}

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		logger.Error("load config", "error", err)
		os.Exit(1)
	}

	auth, err := newAppAuth(cfg.GitHub.AppID, cfg.GitHub.PrivateKeyFile)
	if err != nil {
		logger.Error("init github app auth", "path", cfg.GitHub.PrivateKeyFile, "error", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(cfg.LogDir, 0o755); err != nil {
		logger.Error("create log dir", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	p := newPool(cfg, newGHClient(auth), execLauncher{}, logger)

	if err := p.sweep(ctx); err != nil {
		logger.Error("sweep", "error", err)
		os.Exit(1)
	}
	// Every boot mints a JIT config, so a GitHub outage at start leaves the pool
	// short; the poll loop's top-up recovers it.
	wanted := 0
	for _, class := range cfg.Classes {
		wanted += class.Warm
	}
	if booted := p.fill(ctx); booted < wanted {
		logger.Warn("warm pool started short; the poll loop keeps trying", "classes", len(cfg.Classes), "booted", booted, "wanted", wanted)
	} else {
		logger.Info("warm pool filled", "classes", len(cfg.Classes), "booted", booted)
	}

	// Shutdown waits on this: buildLoop finishes a build in flight after ctx ends.
	var buildDone chan struct{}
	if cfg.Spindrift != nil {
		sdTokenRaw, err := os.ReadFile(cfg.Spindrift.TokenFile)
		if err != nil {
			logger.Error("read spindrift token file", "path", cfg.Spindrift.TokenFile, "error", err)
			os.Exit(1)
		}
		builds := &buildSource{
			sd: newSDClient(cfg.Spindrift.URL, strings.TrimSpace(string(sdTokenRaw))),
			spawn: func(ctx context.Context, claim *buildClaim) (*skiff, error) {
				return p.spawn(ctx, p.buildBerth(claim))
			},
			logger: logger,
			stats:  p.stats,
		}
		buildDone = make(chan struct{})
		go func() {
			defer close(buildDone)
			builds.buildLoop(ctx, cfg.Spindrift.Classes, time.Duration(cfg.Spindrift.PollInterval))
		}()
		logger.Info("spindrift build source enabled", "classes", cfg.Spindrift.Classes)
	}

	p.pollLoop(ctx)

	// stop() restores default signal handling, so a second signal kills outright.
	// The drain's GitHub calls need a context that outlives the run context.
	stop()
	logger.Info("draining", "timeout", cfg.DrainTimeout.String())
	drainCtx, cancel := context.WithTimeout(context.Background(), time.Duration(cfg.DrainTimeout))
	defer cancel()
	p.drain(drainCtx)
	if buildDone != nil {
		<-buildDone
	}
	logger.Info("shutting down")
}
