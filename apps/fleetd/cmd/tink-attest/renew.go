package main

import (
	"context"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/go-tpm/legacy/tpm2"

	"github.com/jonpulsifer/infra/apps/fleetd/client"
)

// printf logs to stdout only: a renewal runs in a pod, where the node's
// consoles are not the owner's.
func printf(format string, args ...any) {
	os.Stdout.WriteString("renew: " + fmt.Sprintf(format, args...) + "\n")
}

type renewOpts struct {
	url, device, eventLog, serial string
	caBundle, bios                string
	before, timeout               time.Duration
	namespace, selector, node     string
	check                         bool
	// http is the client for the attest service; nil uses a one-minute timeout.
	http *http.Client
}

// errNoTPM is a run that found no TPM device: nothing is sent, so nothing
// can quarantine the node, and the service's missing-check alert says so.
var errNoTPM = errors.New("no TPM device")

// renew runs once, or with -every forever: the next run follows a run that
// succeeded after -every, and one that failed after -retry.
func renew(args []string) error {
	var o renewOpts
	fs := flag.NewFlagSet("renew", flag.ContinueOnError)
	fs.StringVar(&o.url, "url", env("ATTEST_URL", ""), "fleetd DevID listener base URL")
	fs.StringVar(&o.caBundle, "ca-bundle", env("CA_BUNDLE", ""), "PEM file of the issuing DevID CAs a renewed certificate must chain to")
	fs.StringVar(&o.device, "tpm", env("TPM_DEVICE", "/dev/tpmrm0"), "TPM resource manager device")
	fs.StringVar(&o.eventLog, "event-log", env("EVENT_LOG", "/sys/kernel/security/tpm0/binary_bios_measurements"), "TCG event log")
	fs.StringVar(&o.serial, "serial", env("SERIAL", readTrim("/sys/class/dmi/id/product_serial")), "SMBIOS serial")
	fs.StringVar(&o.bios, "bios", env("BIOS_VERSION", readTrim("/sys/class/dmi/id/bios_version")), "SMBIOS BIOS version, under which the service records PCR 0")
	fs.DurationVar(&o.before, "renew-before", 30*24*time.Hour, "renew when the LDevID expires within this long")
	fs.BoolVar(&o.check, "check", env("CHECK", "true") == "true", "when no renewal is due, run the daily check: a quote the service judges and records, with no new certificate")
	fs.StringVar(&o.namespace, "restart-namespace", env("RESTART_NAMESPACE", ""), "namespace of the pods to restart after a renewal")
	fs.StringVar(&o.selector, "restart-selector", env("RESTART_SELECTOR", ""), "label selector of the pods to restart after a renewal; empty restarts none")
	fs.StringVar(&o.node, "node", env("NODE_NAME", ""), "this node's Kubernetes name")
	fs.DurationVar(&o.timeout, "timeout", 5*time.Minute, "give up on one run after this long")
	every := fs.Duration("every", 0, "run again this long after a run that succeeded; 0 runs once")
	retry := fs.Duration("retry", time.Hour, "with -every, run again this long after a run that failed")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if o.url == "" {
		return errors.New("ATTEST_URL is required")
	}
	if o.serial == "" {
		return errors.New("no SMBIOS serial; run as root or set SERIAL")
	}
	if o.caBundle == "" {
		return errors.New("-ca-bundle is required")
	}
	if o.selector != "" && (o.namespace == "" || o.node == "") {
		return errors.New("-restart-selector needs -restart-namespace and NODE_NAME")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	for {
		err := renewOnce(ctx, o)
		if *every <= 0 {
			return err
		}
		wait := *every
		switch {
		case errors.Is(err, errNoTPM):
			printf("NO TPM: %v; nothing was sent, so the node is not quarantined for it, and TalosAttestNotChecked alerts", err)
			wait = *retry
		case err != nil:
			printf("RENEWAL FAILED: %v", err)
			wait = *retry
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// renewOnce reads everything local first: a run without the TPM, the event
// log or the CA bundle sends nothing to the service.
func renewOnce(parent context.Context, o renewOpts) error {
	rw, err := tpm2.OpenTPM(o.device)
	if err != nil {
		return fmt.Errorf("%w: open %s: %v", errNoTPM, o.device, err)
	}
	defer rw.Close()
	// Read on every run, so a rotated CA in the mounted ConfigMap takes effect.
	pem, err := os.ReadFile(o.caBundle)
	if err != nil {
		return fmt.Errorf("DevID CA bundle: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		return fmt.Errorf("DevID CA bundle %s holds no certificate", o.caBundle)
	}
	log, err := os.ReadFile(o.eventLog)
	if err != nil {
		return fmt.Errorf("event log: %w", err)
	}
	if len(log) == 0 {
		return fmt.Errorf("event log %s is empty", o.eventLog)
	}
	hc := o.http
	if hc == nil {
		hc = &http.Client{Timeout: time.Minute}
	}

	ctx, cancel := context.WithTimeout(parent, o.timeout)
	defer cancel()
	res, err := client.Renew(ctx, rw, client.RenewConfig{
		BaseURL:     o.url,
		HTTP:        hc,
		Serial:      o.serial,
		EventLog:    log,
		Roots:       roots,
		RenewBefore: o.before,
		Check:       o.check,
		BIOS:        o.bios,
		Logf:        printf,
	})
	if errors.Is(err, client.ErrNoLDevID) {
		printf("serial %s: %v; nothing to renew", o.serial, err)
		return nil
	}
	if errors.Is(err, client.ErrCheckUnsupported) {
		printf("serial %s: %v; no check today", o.serial, err)
		return nil
	}
	if err != nil {
		return err
	}
	if res.Checked {
		printf("CHECKED: serial %s, attested %s", o.serial, res.AttestedAt.Format(time.RFC3339))
		return nil
	}
	if !res.Renewed {
		return nil
	}
	printf("RENEWED: serial %s, LDevID expires %s", o.serial, res.NotAfter.Format(time.RFC3339))
	if o.selector == "" {
		return nil
	}
	k, err := inCluster()
	if err != nil {
		return fmt.Errorf("restart %s: %w", o.selector, err)
	}
	// The next run finds nothing due and restarts nothing, so this run keeps
	// trying while its context lasts.
	for {
		deleted, err := k.restartPods(ctx, o.namespace, o.selector, o.node)
		if err == nil {
			printf("restarted %s/%s on %s: %s", o.namespace, o.selector, o.node, strings.Join(deleted, ", "))
			return nil
		}
		printf("restart: %v", err)
		select {
		case <-ctx.Done():
			return fmt.Errorf("the LDevID is renewed but %s on %s still runs the old one: %w", o.selector, o.node, err)
		case <-time.After(15 * time.Second):
		}
	}
}
