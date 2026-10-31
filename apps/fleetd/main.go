// fleetd decides whether a machine may become a folly node, gives it the
// means to become one, and keeps watching it. It verifies TPM evidence from
// HookOS and from running nodes and issues each node's LDevID (./attest),
// turns NetBox's devices into Tinkerbell objects, and renders and serves the
// Talos config a first boot fetches (./fleet). An intake pass's install code
// is minted and its config rendered in this one process. README.md holds the
// contract.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/attest"
	"github.com/jonpulsifer/infra/apps/fleetd/fleet"
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
		log.Error("fleetd stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	srv, err := attest.FromEnv(log)
	if err != nil {
		return err
	}
	r, err := newFleet()
	if err != nil {
		return err
	}
	srv.V.Installer = attest.InstallerFunc(func(ctx context.Context, req attest.InstallRequest) error {
		return r.Admit(ctx, fleet.RenderRequest{Serial: req.Serial, UUID: req.UUID, Node: req.Node, Class: req.Class, Code: req.Code})
	})
	srv.V.Expected = r.Expected
	r.Identities = func() ([]fleet.Identity, error) {
		ids, err := srv.V.Store.Identities()
		if err != nil {
			return nil, err
		}
		out := make([]fleet.Identity, len(ids))
		for i, id := range ids {
			out[i] = fleet.Identity(id)
		}
		return out, nil
	}

	var secret []byte
	if f := os.Getenv("FLEET_WEBHOOK_SECRET_FILE"); f != "" {
		s, err := fleet.ReadSecret(f)
		if err != nil {
			return fmt.Errorf("webhook secret: %w", err)
		}
		secret = []byte(s)
	}
	trigger := make(chan string, 1)
	control := http.NewServeMux()
	control.Handle("POST /webhook", &fleet.Webhook{Secret: secret, Trigger: trigger, Metrics: r.Metrics})
	control.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if ok, why := r.Healthy(3 * r.Config.Interval); !ok {
			http.Error(w, why, http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	control.Handle("GET /metrics", r.Metrics)

	var kp *keyPair
	if cert, key := os.Getenv("FLEETD_TLS_CERT"), os.Getenv("FLEETD_TLS_KEY"); cert != "" || key != "" {
		if cert == "" || key == "" {
			return errors.New("FLEETD_TLS_CERT and FLEETD_TLS_KEY go together")
		}
		kp = &keyPair{cert: cert, key: key}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	server := func(h http.Handler) *http.Server {
		// WriteTimeout bounds a whole answer; a render waits on talosctl for
		// up to 20 seconds.
		return &http.Server{
			Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
			WriteTimeout: time.Minute, IdleTimeout: 2 * time.Minute,
		}
	}
	// The DevID listener, which every node's renewal and daily check reach,
	// and the others bind first and on their own: the boot listener's
	// certificate or address never takes them down.
	listeners := []struct {
		addr    string
		mode    fs.FileMode
		handler http.Handler
	}{
		{env("ATTEST_DEVID_ADDR", ":8444"), 0o660, srv.DevIDHandler()},
		{env("ATTEST_ADMIN_ADDR", ":8445"), 0o600, srv.Admin()},
		{env("FLEET_WEBHOOK_ADDR", ":8446"), 0o660, control},
	}
	servers := make([]*http.Server, 0, len(listeners)+1)
	errc := make(chan error, len(listeners))
	for _, l := range listeners {
		ln, err := attest.Listen(l.addr, l.mode)
		if err != nil {
			return err
		}
		s := server(l.handler)
		servers = append(servers, s)
		log.Info("listening", "addr", l.addr)
		go func() { errc <- s.Serve(ln) }()
	}
	boot := server(bootHandler(srv, r.Installer))
	servers = append(servers, boot)
	go serveBoot(ctx, log, boot, env("FLEETD_BOOT_ADDR", ":8443"), kp, 10*time.Second)
	go srv.V.RunBackfill(ctx, 10*time.Minute)
	go r.Loop(ctx, trigger)
	if r.Installer != nil {
		go r.Installer.Warm(ctx)
	}
	log.Info("fleetd started")

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

// newFleet builds the reconciler and its installer from the FLEET_*
// environment.
func newFleet() (*fleet.Reconciler, error) {
	cfg, err := fleet.LoadConfig()
	if err != nil {
		return nil, err
	}
	tokenFile := os.Getenv("FLEET_NETBOX_TOKEN_FILE")
	netboxURL := os.Getenv("FLEET_NETBOX_URL")
	if netboxURL == "" || tokenFile == "" {
		return nil, errors.New("FLEET_NETBOX_URL and FLEET_NETBOX_TOKEN_FILE are required")
	}
	token, err := fleet.ReadSecret(tokenFile)
	if err != nil {
		return nil, fmt.Errorf("NetBox token: %w", err)
	}
	netbox := &fleet.NetBox{URL: netboxURL, Token: token, Client: &http.Client{Timeout: 30 * time.Second}}
	kube, err := fleet.NewKube(
		env("FLEET_KUBE_SERVER", "https://localhost:6443"),
		env("FLEET_KUBE_CA_FILE", "/etc/tinkerbell/ca.crt"),
		env("FLEET_KUBE_CERT_FILE", "/etc/tinkerbell/admin.crt"),
		env("FLEET_KUBE_KEY_FILE", "/etc/tinkerbell/admin.key"),
		cfg.Namespace,
	)
	if err != nil {
		return nil, fmt.Errorf("Tinkerbell API client: %w", err)
	}
	cluster, err := fleet.LoadCluster()
	if err != nil {
		return nil, err
	}
	metrics := fleet.NewMetrics()
	installer, err := fleet.LoadInstaller(&cfg, netbox, kube, metrics)
	if err != nil {
		return nil, err
	}
	var links *fleet.TFTPLinks
	if dir := os.Getenv("FLEET_TFTP_DIR"); dir != "" {
		target := os.Getenv("FLEET_TFTP_LINK_TARGET")
		if target == "" {
			return nil, errors.New("FLEET_TFTP_DIR needs FLEET_TFTP_LINK_TARGET")
		}
		links = &fleet.TFTPLinks{Dir: dir, Target: target}
	}
	return &fleet.Reconciler{Config: cfg, NetBox: netbox, Kube: kube, Cluster: cluster, Installer: installer, Metrics: metrics, Links: links, SpireNodesFile: os.Getenv("FLEET_SPIRE_NODES_FILE"), Now: time.Now}, nil
}

// serveBoot serves the boot listener, with TLS when kp is set. Until its
// certificate reads and its address binds, such as before the ACME unit
// writes the certificate or networkd configures the bootstrap address, it
// tries again every retry, and a listener that fails later binds again.
func serveBoot(ctx context.Context, log *slog.Logger, s *http.Server, addr string, kp *keyPair, retry time.Duration) {
	if kp != nil {
		s.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: kp.get}
	}
	for {
		err := func() error {
			if kp != nil {
				if _, err := kp.get(nil); err != nil {
					return fmt.Errorf("the certificate: %w", err)
				}
			}
			ln, err := attest.Listen(addr, 0o660)
			if err != nil {
				return err
			}
			log.Info("listening", "addr", addr, "tls", kp != nil)
			if kp != nil {
				return s.ServeTLS(ln, "", "")
			}
			return s.Serve(ln)
		}()
		if errors.Is(err, http.ErrServerClosed) {
			return
		}
		log.Error("the boot listener is down; it tries again", "addr", addr, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(retry):
		}
	}
}

// bootHandler serves what a netbooting machine and a first boot reach: the
// device flow under /attest/ and the one-time config at /talos/config.
func bootHandler(srv *attest.Server, installer http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/attest/", http.StripPrefix("/attest", srv.Public()))
	mux.Handle("/talos/config", installer)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("/", http.NotFound)
	return mux
}

// keyPair serves the certificate files the host's ACME client renews,
// reading them again when the certificate's modification time changes.
type keyPair struct {
	cert, key string

	mu       sync.Mutex
	modified time.Time
	checked  time.Time
	current  *tls.Certificate
}

func (k *keyPair) get(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.current != nil && time.Since(k.checked) < time.Minute {
		return k.current, nil
	}
	k.checked = time.Now()
	fi, err := os.Stat(k.cert)
	if err != nil {
		if k.current != nil {
			return k.current, nil
		}
		return nil, err
	}
	if k.current != nil && fi.ModTime().Equal(k.modified) {
		return k.current, nil
	}
	c, err := tls.LoadX509KeyPair(k.cert, k.key)
	if err != nil {
		if k.current != nil {
			return k.current, nil
		}
		return nil, err
	}
	k.current, k.modified = &c, fi.ModTime()
	return k.current, nil
}
