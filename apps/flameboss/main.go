// flameboss exports one barbecue's cook telemetry as Prometheus metrics.
//
// The controller publishes to Flame Boss's cloud MQTT brokers, not to the lab.
// This process holds the account's MQTT credentials, follows each controller to
// whichever server it is currently on (see Relay), and turns its `temps`
// uplinks into series Prometheus can keep and Alertmanager can read. Nothing
// is written back to the controller.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envDuration(key string, fallback time.Duration, log *slog.Logger) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		log.Warn("ignoring unparseable duration", "env", key, "value", v)
		return fallback
	}
	return d
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: map[string]slog.Level{"debug": slog.LevelDebug, "warn": slog.LevelWarn}[os.Getenv("LOG_LEVEL")],
	}))

	opts := Options{
		Host:     envOr("FLAMEBOSS_HOST", "myflameboss.com"),
		TLS:      os.Getenv("FLAMEBOSS_TLS") != "false",
		Username: os.Getenv("FLAMEBOSS_USERNAME"),
		Password: os.Getenv("FLAMEBOSS_PASSWORD"),
	}
	port, err := strconv.Atoi(envOr("FLAMEBOSS_PORT", "8883"))
	if err != nil {
		log.Error("FLAMEBOSS_PORT is not a number", "value", os.Getenv("FLAMEBOSS_PORT"))
		os.Exit(1)
	}
	opts.Port = port
	if opts.Username == "" || opts.Password == "" {
		log.Error("FLAMEBOSS_USERNAME and FLAMEBOSS_PASSWORD are required (the T-<user_id> username and token from myflameboss.com/users/dev)")
		os.Exit(1)
	}

	// Five minutes of quiet ends the cook's `active` flag; half an hour ends
	// the cook. The controller publishes about once a minute while it holds a
	// steady pit, so five minutes is several missed readings rather than one.
	state := NewState(
		envDuration("FLAMEBOSS_STALE_AFTER", 5*time.Minute, log),
		envDuration("FLAMEBOSS_RETIRE_AFTER", 30*time.Minute, log),
	)

	registry := prometheus.NewRegistry()
	registry.MustRegister(state)

	relay := NewRelay(opts, state, log)
	if err := relay.Start(); err != nil {
		log.Error("cannot start relay", "err", err)
		os.Exit(1)
	}
	defer relay.Stop()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		t := time.NewTicker(envDuration("FLAMEBOSS_ANNOUNCE_EVERY", 15*time.Minute, log))
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				relay.Announce()
			}
		}
	}()

	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	// Liveness only. Readiness cannot mean "the cloud answered": the barbecue
	// is off most of the week, and a pod that reports unready whenever nobody
	// is cooking is a pod Kubernetes restarts for no reason.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})

	srv := &http.Server{
		Addr:              envOr("FLAMEBOSS_LISTEN", ":8080"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()

	log.Info("listening", "addr", srv.Addr, "broker", opts.Host, "user", opts.UserID())
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("http server failed", "err", err)
		os.Exit(1)
	}
}
