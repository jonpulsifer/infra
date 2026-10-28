// talos-enroll serves the OAuth device flow that a Talos machine runs before it
// fetches talos.config, and releases each machine's config once the owner
// approves it. The contract is in README.md.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("talos-enroll stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	inputs, err := LoadMachineInputs(env("ENROLL_MACHINE_INPUTS", "/etc/talos-enroll/machine-inputs.json"))
	if err != nil {
		return err
	}
	macs, err := LoadNodeMACs(env("ENROLL_NODE_MACS", "/etc/talos-enroll/node-macs.json"))
	if err != nil {
		return err
	}
	approvers := map[string]bool{}
	for _, a := range strings.Split(os.Getenv("ENROLL_APPROVERS"), ",") {
		if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
			approvers[a] = true
		}
	}
	if len(approvers) == 0 {
		return errors.New("ENROLL_APPROVERS names no tailnet login")
	}
	adminURL := strings.TrimSuffix(os.Getenv("ENROLL_ADMIN_URL"), "/")
	if adminURL == "" {
		return errors.New("ENROLL_ADMIN_URL is required")
	}

	render := &Talosctl{
		Bin:        env("ENROLL_TALOSCTL", "talosctl"),
		BundlePath: env("ENROLL_SECRETS_BUNDLE", "/var/run/secrets/talos-enroll/bundle/secrets.yaml"),
		Inputs:     inputs,
	}
	if len(inputs) == 0 {
		log.Warn("the machine inputs name no node, so every approval fails")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	out := NewOutbox(&Discord{
		URLFile: env("ENROLL_DISCORD_WEBHOOK_FILE", "/var/run/secrets/talos-enroll/discord/webhook-url"),
		Client:  &http.Client{Timeout: 10 * time.Second},
	}, log)
	go out.Run(ctx)

	srv := &Server{
		Store:     NewStore(time.Now),
		Render:    render,
		Out:       out,
		Log:       log,
		ClientID:  env("ENROLL_CLIENT_ID", "talos-enroll"),
		Approvers: approvers,
		AdminURL:  adminURL,
		MACs:      macs,
		Now:       time.Now,
	}

	// A unix socket's mode decides who may connect: the public one admits the
	// service's group (a TLS proxy), the admin one only its owner and root (tailscaled).
	listeners := []struct {
		addr    string
		mode    fs.FileMode
		handler http.Handler
	}{
		{env("ENROLL_ADDR", ":8080"), 0o660, srv.Public()},
		{env("ENROLL_ADMIN_ADDR", ":8081"), 0o600, srv.Admin()},
	}
	servers := make([]*http.Server, 0, len(listeners))
	errc := make(chan error, len(listeners))
	for _, l := range listeners {
		ln, err := listen(l.addr, l.mode)
		if err != nil {
			return err
		}
		s := &http.Server{Handler: l.handler, ReadHeaderTimeout: 10 * time.Second}
		servers = append(servers, s)
		log.Info("listening", "addr", l.addr)
		go func() { errc <- s.Serve(ln) }()
	}
	log.Info("talos-enroll started", "nodes", render.Nodes(), "approvers", len(approvers))

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdown)
	}
	return nil
}

// listen opens a TCP address, or a unix socket given as unix:<path> with mode.
func listen(addr string, mode fs.FileMode) (net.Listener, error) {
	path, ok := strings.CutPrefix(addr, "unix:")
	if !ok {
		return net.Listen("tcp", addr)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, mode); err != nil {
		ln.Close()
		return nil, fmt.Errorf("chmod %s: %w", path, err)
	}
	return ln, nil
}
