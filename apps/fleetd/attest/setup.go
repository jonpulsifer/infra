package attest

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/classes"
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

// FromEnv builds the verifier and its handlers from the ATTEST_* environment
// that README.md lists. The caller sets the Verifier's Installer and serves
// the handlers.
func FromEnv(log *slog.Logger) (*Server, error) {
	site := env("ATTEST_SITE", "folly")
	// 90 days: the running node renews from 30 days out, and a machine
	// that stops renewing loses its identity, which is the revocation.
	validity, err := time.ParseDuration(env("ATTEST_CERT_VALIDITY", "2160h"))
	if err != nil {
		return nil, fmt.Errorf("ATTEST_CERT_VALIDITY: %w", err)
	}
	ca, err := loadCA(env("ATTEST_CA_CHAIN", "/etc/fleetd/devid-ca-chain.pem"), validity)
	if err != nil {
		return nil, err
	}
	ca.Site = site
	// The bundle holds every issuing CA of the site: an LDevID another CA
	// issued verifies, and renews from this one.
	if bundle := os.Getenv("ATTEST_CA_BUNDLE"); bundle != "" {
		issuers, err := readChain(bundle)
		if err != nil {
			return nil, fmt.Errorf("ATTEST_CA_BUNDLE: %w", err)
		}
		if err := ca.AddIssuers(issuers); err != nil {
			return nil, fmt.Errorf("ATTEST_CA_BUNDLE: %w", err)
		}
	}
	log.Info("DevID CA loaded", "subject", ca.Cert.Subject.String(), "pkcs11", pkcs11Configured(), "site", site, "issuers", ca.issuerNames())
	roots, err := LoadEKRoots(env("ATTEST_EK_ROOTS", "/etc/fleetd/roots"))
	if err != nil {
		return nil, err
	}
	policies, err := LoadPolicies(env("ATTEST_POLICY", "/etc/fleetd/policy"))
	if err != nil {
		return nil, err
	}
	table, err := classes.Load(env("FLEET_CLASSES", "/etc/fleetd/classes.json"))
	if err != nil {
		return nil, err
	}
	if err := CheckClasses(table, policies); err != nil {
		return nil, err
	}
	store, err := OpenStore(env("ATTEST_STATE_DIR", "/var/lib/fleetd/attest"))
	if err != nil {
		return nil, err
	}
	approvers := map[string]bool{}
	for _, a := range strings.Split(os.Getenv("ATTEST_APPROVERS"), ",") {
		if a = strings.ToLower(strings.TrimSpace(a)); a != "" {
			approvers[a] = true
		}
	}
	if len(approvers) == 0 {
		return nil, errors.New("ATTEST_APPROVERS names no tailnet login")
	}

	v := &Verifier{
		Roots:      roots,
		Policies:   policies,
		Classes:    table,
		CA:         ca,
		Store:      store,
		Audit:      &Audit{W: os.Stdout, Site: site},
		Log:        log,
		Now:        time.Now,
		SessionTTL: 5 * time.Minute,
	}
	u := os.Getenv("ATTEST_NETBOX_URL")
	if u == "" {
		return nil, errors.New("ATTEST_NETBOX_URL is required: NetBox is the only source of machines")
	}
	tok, err := os.ReadFile(env("ATTEST_NETBOX_TOKEN_FILE", "/run/credentials/fleetd.service/netbox-token"))
	if err != nil {
		return nil, fmt.Errorf("the NetBox token is unreadable: %w", err)
	}
	nb := &NetBox{URL: u, Token: strings.TrimSpace(string(tok)), Client: &http.Client{Timeout: 10 * time.Second}, Log: log}
	if store.PendingMax, err = strconv.Atoi(env("ATTEST_PENDING_MAX", "50")); err != nil {
		return nil, fmt.Errorf("ATTEST_PENDING_MAX: %w", err)
	}
	v.NetBox = nb
	v.BindingAuthor = strings.TrimSpace(os.Getenv("ATTEST_BINDING_AUTHOR"))
	if v.BindingAuthor == "" {
		log.Warn("ATTEST_BINDING_AUTHOR is unset, so no approved EK binding counts and every planned machine waits")
	}
	v.Recorders = append(v.Recorders, nb)
	log.Info("NetBox is the system of record", "url", u, "site", site)
	if metricsFile := os.Getenv("ATTEST_METRICS_FILE"); metricsFile != "" {
		v.OnChange = func() {
			if err := v.WriteMetricsFile(metricsFile); err != nil {
				log.Error("metrics file", "err", err)
			}
		}
		v.OnChange()
	}
	log.Info("attestation ready", "ek_roots", roots.Count, "ca", ca.Cert.Subject.String())
	return &Server{V: v, Log: log, Approvers: approvers}, nil
}

// RunBackfill writes the passes NetBox lacks at once and then every
// interval, until ctx ends, so NetBox's empty verdict never hides one.
func (v *Verifier) RunBackfill(ctx context.Context, interval time.Duration) {
	v.BackfillNetBox(ctx)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			v.BackfillNetBox(ctx)
		}
	}
}

// Listen opens a TCP address, or a unix socket given as unix:<path> with mode.
func Listen(addr string, mode fs.FileMode) (net.Listener, error) {
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
