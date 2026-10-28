// talos-attest attests a Talos node's TPM before the node gets a config: it
// checks the EK chain and the inventory, activates a credential, checks a
// quote and the event log against policy.yaml, and issues an LDevID and a
// LAK certificate from the DevID CA. The contract is in README.md.
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

// loadCA signs with the PKCS#11 token key when ATTEST_CA_PKCS11_MODULE is set, and with the
// software key in ATTEST_CA_KEY otherwise.
func loadCA(chainPath string, validity time.Duration) (*CA, error) {
	if pkcs11Configured() {
		return loadPKCS11CA(chainPath, validity)
	}
	keyPath := os.Getenv("ATTEST_CA_KEY")
	if keyPath == "" {
		return nil, errors.New("ATTEST_CA_KEY or ATTEST_CA_PKCS11_MODULE is required: the DevID CA's software key, from terraform/pki's devid_ca_private_key output, or its token")
	}
	return LoadCA(keyPath, chainPath, validity)
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("talos-attest stopped", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	validity, err := time.ParseDuration(env("ATTEST_CERT_VALIDITY", "8760h"))
	if err != nil {
		return fmt.Errorf("ATTEST_CERT_VALIDITY: %w", err)
	}
	ca, err := loadCA(env("ATTEST_CA_CHAIN", "/etc/talos-attest/devid-ca-chain.pem"), validity)
	if err != nil {
		return err
	}
	log.Info("DevID CA loaded", "subject", ca.Cert.Subject.String(), "pkcs11", pkcs11Configured())
	roots, err := LoadEKRoots(env("ATTEST_EK_ROOTS", "/etc/talos-attest/roots"))
	if err != nil {
		return err
	}
	policy, err := LoadPolicy(env("ATTEST_POLICY", "/etc/talos-attest/policy.yaml"))
	if err != nil {
		return err
	}
	inv, err := LoadInventory(env("ATTEST_INVENTORY", "/etc/talos-attest/machines.yaml"))
	if err != nil {
		return err
	}
	store, err := OpenStore(env("ATTEST_STATE_DIR", "/var/lib/talos-attest"))
	if err != nil {
		return err
	}
	approvers := map[string]bool{}
	for _, a := range strings.Split(os.Getenv("ATTEST_APPROVERS"), ",") {
		if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
			approvers[a] = true
		}
	}
	if len(approvers) == 0 {
		return errors.New("ATTEST_APPROVERS names no tailnet login")
	}

	client := &http.Client{Timeout: 10 * time.Second}
	v := &Verifier{
		Inventory:  inv,
		Roots:      roots,
		Policy:     policy,
		CA:         ca,
		Store:      store,
		Log:        log,
		Now:        time.Now,
		SessionTTL: 5 * time.Minute,
	}
	if u := os.Getenv("ATTEST_NETBOX_URL"); u != "" {
		tok, err := os.ReadFile(env("ATTEST_NETBOX_TOKEN_FILE", "/run/credentials/talos-attest.service/netbox-token"))
		if err != nil {
			return fmt.Errorf("ATTEST_NETBOX_URL is set but the token is unreadable: %w", err)
		}
		nb := &NetBox{URL: u, Token: strings.TrimSpace(string(tok)), Client: client, PassStatus: env("ATTEST_NETBOX_PASS_STATUS", "active")}
		v.Recorders = append(v.Recorders, nb)
		v.Pins = nb
		log.Info("NetBox writes on", "url", u)
	}
	if path := os.Getenv("ATTEST_METRICS_FILE"); path != "" {
		v.OnChange = func() {
			if err := v.WriteMetricsFile(path); err != nil {
				log.Error("metrics file", "err", err)
			}
		}
		v.OnChange()
	}

	var peers []string
	for _, p := range strings.Split(os.Getenv("ATTEST_PEERS"), ",") {
		if p = strings.TrimSpace(p); p != "" {
			peers = append(peers, p)
		}
	}
	srv := &Server{V: v, Log: log, Approvers: approvers, Peers: peers, Client: client}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	listeners := []struct {
		addr    string
		mode    fs.FileMode
		handler http.Handler
	}{
		{env("ATTEST_ADDR", ":8080"), 0o660, srv.Public()},
		{env("ATTEST_DEVID_ADDR", ":8082"), 0o660, srv.DevIDHandler()},
		{env("ATTEST_ADMIN_ADDR", ":8081"), 0o600, srv.Admin()},
	}
	servers := make([]*http.Server, 0, len(listeners))
	errc := make(chan error, len(listeners))
	for _, l := range listeners {
		ln, err := listen(l.addr, l.mode)
		if err != nil {
			return err
		}
		s := &http.Server{Handler: l.handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second}
		servers = append(servers, s)
		log.Info("listening", "addr", l.addr)
		go func() { errc <- s.Serve(ln) }()
	}
	log.Info("talos-attest started", "machines", inv.Names(), "ek_roots", roots.Count, "ca", ca.Cert.Subject.String(), "peers", peers)

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
