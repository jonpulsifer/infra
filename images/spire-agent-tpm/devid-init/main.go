// spire-devid-init runs before the SPIRE agent on a TPM node. It fetches the
// node's LDevID from the attest service by SMBIOS serial, writes the files that
// SPIRE's tpm_devid attestor loads, and renders the agent's config with that
// attestor. With no attest URL, or no usable LDevID, it renders the config with
// the EK-hash attestor instead, so an agent always starts.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	attestorEK    = "tpm"
	attestorDevID = "tpm_devid"
)

type options struct {
	attestURL string
	nodeName  string
	serial    string
	configDir string
	devidDir  string
	dataDir   string
	out       string
	attempts  int
	backoff   time.Duration
	client    *http.Client
	now       func() time.Time
}

func main() {
	o := options{
		attestURL: strings.TrimSuffix(os.Getenv("ATTEST_URL"), "/"),
		nodeName:  os.Getenv("NODE_NAME"),
		attempts:  3,
		backoff:   2 * time.Second,
		client:    &http.Client{Timeout: 5 * time.Second},
		now:       time.Now,
	}
	flag.StringVar(&o.serial, "serial", "/host/dmi/product_serial", "the file holding the SMBIOS system serial")
	flag.StringVar(&o.configDir, "config-dir", "/run/spire/config", "the directory holding agent.conf and one file per node attestor")
	flag.StringVar(&o.devidDir, "devid-dir", "/run/spire/devid", "where to write the LDevID files")
	flag.StringVar(&o.dataDir, "data-dir", "/var/lib/spire-agent", "the agent's data directory with the EK attestor; tpm_devid uses a subdirectory")
	flag.StringVar(&o.out, "out", "/run/spire/agent/agent.conf", "where to write the rendered agent config")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	attestor, err := run(context.Background(), log, o)
	if err != nil {
		log.Error("no agent config rendered", "err", err)
		os.Exit(1)
	}
	log.Info("agent config rendered", "attestor", attestor, "path", o.out)
}

// run picks the attestor, writes the LDevID files when it picks tpm_devid, and
// renders the config. Only a failure to render is an error.
func run(ctx context.Context, log *slog.Logger, o options) (string, error) {
	attestor := attestorEK
	if o.attestURL == "" {
		log.Info("ATTEST_URL is empty, so the agent attests by EK hash")
	} else if err := provision(ctx, o); err != nil {
		log.Warn("no usable LDevID, so the agent attests by EK hash", "err", err)
	} else {
		attestor = attestorDevID
	}
	dataDir := o.dataDir
	if attestor == attestorDevID {
		// Its own directory, so an SVID the EK attestor issued never stands in
		// for the LDevID's, and a rollback finds the EK agent's state intact.
		dataDir = filepath.Join(o.dataDir, attestorDevID)
	}
	return attestor, render(o.configDir, attestor, dataDir, o.out)
}

func provision(ctx context.Context, o options) error {
	raw, err := os.ReadFile(o.serial)
	if err != nil {
		return fmt.Errorf("read the SMBIOS serial: %w", err)
	}
	serial := strings.TrimSpace(string(raw))
	if serial == "" {
		return errors.New("the SMBIOS serial is empty")
	}
	d, err := fetchWithRetry(ctx, o, serial)
	if err != nil {
		return err
	}
	if err := d.check(o.nodeName, serial, o.now()); err != nil {
		return err
	}
	return d.write(o.devidDir)
}

func fetchWithRetry(ctx context.Context, o options, serial string) (*DevID, error) {
	var err error
	for attempt := 1; attempt <= o.attempts; attempt++ {
		var d *DevID
		d, err = fetch(ctx, o.client, o.attestURL, serial)
		if err == nil || errors.Is(err, errNotAttested) {
			return d, err
		}
		if attempt < o.attempts {
			time.Sleep(o.backoff)
		}
	}
	return nil, err
}
