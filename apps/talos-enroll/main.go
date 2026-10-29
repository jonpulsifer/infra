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
	inputs, err := LoadClassInputs(env("ENROLL_CLASS_INPUTS", "/etc/talos-enroll/class-inputs.json"))
	if err != nil {
		return err
	}
	worker, err := LoadWorkerSecrets(env("ENROLL_WORKER_SECRETS", "/var/run/secrets/talos-enroll/worker-secrets/worker-secrets.yaml"))
	if err != nil {
		return fmt.Errorf("ENROLL_WORKER_SECRETS: %w", err)
	}
	site := env("ENROLL_SITE", "folly")
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

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// The full bundle is optional: only a control-plane render needs it.
	render := &Talosctl{
		Bin:        env("ENROLL_TALOSCTL", "talosctl"),
		BundlePath: os.Getenv("ENROLL_SECRETS_BUNDLE"),
		Worker:     worker,
		Inputs:     inputs,
	}
	if err := render.Init(ctx); err != nil {
		return err
	}
	if len(inputs) == 0 {
		log.Warn("the class inputs name no class, so every approval fails")
	}

	// NetBox is the directory, and the inventory export answers when it does
	// not. Without NetBox every approval is a click.
	inventory, err := LoadInventory(os.Getenv("ENROLL_INVENTORY"))
	if err != nil {
		return fmt.Errorf("ENROLL_INVENTORY: %w", err)
	}
	var dir Directory = inventory
	netboxURL := strings.TrimSuffix(os.Getenv("ENROLL_NETBOX_URL"), "/")
	if netboxURL != "" {
		tok, err := os.ReadFile(env("ENROLL_NETBOX_TOKEN_FILE", "/run/credentials/talos-enroll.service/netbox-token"))
		if err != nil {
			return fmt.Errorf("ENROLL_NETBOX_URL is set but the token is unreadable: %w", err)
		}
		nb := &NetBox{URL: netboxURL, Token: strings.TrimSpace(string(tok)), Site: site, Client: &http.Client{Timeout: 10 * time.Second}, Log: log}
		dir = &Fallback{Primary: nb, Secondary: inventory, Log: log}
		log.Info("NetBox is the directory", "netbox_url", netboxURL, "site", site)
	} else {
		log.Info("no NetBox, so the inventory file is the directory")
	}

	// Auto-approval needs both: NetBox for the lifecycle and the spend, the
	// attest service for the binding of the attestation to the request.
	var auto *AutoApproval
	attestURL := strings.TrimSuffix(os.Getenv("ENROLL_ATTEST_URL"), "/")
	switch {
	case netboxURL != "" && attestURL != "":
		window, err := time.ParseDuration(env("ENROLL_AUTO_APPROVE_WINDOW", "2h"))
		if err != nil || window <= 0 {
			return fmt.Errorf("ENROLL_AUTO_APPROVE_WINDOW must be a positive duration: %q", os.Getenv("ENROLL_AUTO_APPROVE_WINDOW"))
		}
		auto = &AutoApproval{
			Attest: &AttestClient{BaseURL: attestURL, Client: &http.Client{Timeout: 5 * time.Second}},
			Dir:    dir,
			Window: window,
		}
		log.Info("a staged worker with an unspent attestation is approved without a click", "attest_url", attestURL, "window", window.String())
	case attestURL != "":
		log.Warn("ENROLL_ATTEST_URL without ENROLL_NETBOX_URL approves nothing: every approval is a click")
	default:
		log.Info("every approval is a click")
	}

	out := NewOutbox(&Discord{
		URLFile: env("ENROLL_DISCORD_WEBHOOK_FILE", "/var/run/secrets/talos-enroll/discord/webhook-url"),
		Client:  &http.Client{Timeout: 10 * time.Second},
	}, log)
	go out.Run(ctx)

	srv := &Server{
		Store:     NewStore(time.Now),
		Render:    render,
		Dir:       dir,
		Out:       out,
		Log:       log,
		Site:      site,
		ClientID:  env("ENROLL_CLIENT_ID", "talos-enroll"),
		Approvers: approvers,
		AdminURL:  adminURL,
		Now:       time.Now,
		Auto:      auto,
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
	log.Info("talos-enroll started", "classes", render.Classes(), "approvers", len(approvers))

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
