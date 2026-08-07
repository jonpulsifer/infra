// bosun keeps a warm pool of "skiffs" — ephemeral cloud-hypervisor microVMs,
// each serving exactly one GitHub Actions job before halting. It is a peer
// of apps/spindrift, not part of it.
//
// A JIT-registered runner is ephemeral by construction: GitHub hands an
// already-booted skiff a matching job unprompted, so bosun never learns a
// job was queued. There is no webhook, no queue listener, and no inbound
// connectivity — bosun boots the configured warm count per class and
// replaces each skiff after it halts. See pool.go for the mint/boot, poll,
// and recycle halves of that loop; hull.go for how a hull manifest becomes
// cloud-hypervisor argv.
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
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

	tokenRaw, err := os.ReadFile(cfg.TokenFile)
	if err != nil {
		logger.Error("read token file", "path", cfg.TokenFile, "error", err)
		os.Exit(1)
	}
	token := strings.TrimSpace(string(tokenRaw))

	if err := os.MkdirAll(cfg.LogDir, 0o755); err != nil {
		logger.Error("create log dir", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	p := newPool(cfg, newGHClient(token), execLauncher{}, logger)

	if err := p.sweep(ctx); err != nil {
		logger.Error("sweep", "error", err)
		os.Exit(1)
	}
	p.fill(ctx)
	logger.Info("warm pool filled", "classes", len(cfg.Classes))

	p.pollLoop(ctx)
	logger.Info("shutting down")
}
