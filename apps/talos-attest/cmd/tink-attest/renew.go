package main

import (
	"context"
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

	"github.com/jonpulsifer/infra/apps/talos-attest/client"
)

// printf logs to stdout only: a renewal runs in a pod, where the node's
// consoles are not the owner's.
func printf(format string, args ...any) {
	os.Stdout.WriteString("renew: " + fmt.Sprintf(format, args...) + "\n")
}

type renewOpts struct {
	url, device, eventLog, serial string
	before, timeout               time.Duration
	namespace, selector, node     string
}

// renew runs once, or with -every forever: the next run follows a run that
// succeeded after -every, and one that failed after -retry.
func renew(args []string) error {
	var o renewOpts
	fs := flag.NewFlagSet("renew", flag.ContinueOnError)
	fs.StringVar(&o.url, "url", env("ATTEST_URL", ""), "talos-attest DevID listener base URL")
	fs.StringVar(&o.device, "tpm", env("TPM_DEVICE", "/dev/tpmrm0"), "TPM resource manager device")
	fs.StringVar(&o.eventLog, "event-log", env("EVENT_LOG", "/sys/kernel/security/tpm0/binary_bios_measurements"), "TCG event log")
	fs.StringVar(&o.serial, "serial", env("SERIAL", readTrim("/sys/class/dmi/id/product_serial")), "SMBIOS serial")
	fs.DurationVar(&o.before, "renew-before", 30*24*time.Hour, "renew when the LDevID expires within this long")
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
		if err != nil {
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

func renewOnce(parent context.Context, o renewOpts) error {
	log, err := os.ReadFile(o.eventLog)
	if err != nil {
		return fmt.Errorf("event log: %w", err)
	}
	rw, err := tpm2.OpenTPM(o.device)
	if err != nil {
		return fmt.Errorf("open %s: %w", o.device, err)
	}
	defer rw.Close()

	ctx, cancel := context.WithTimeout(parent, o.timeout)
	defer cancel()
	res, err := client.Renew(ctx, rw, client.RenewConfig{
		BaseURL:     o.url,
		HTTP:        &http.Client{Timeout: time.Minute},
		Serial:      o.serial,
		EventLog:    log,
		RenewBefore: o.before,
		Logf:        printf,
	})
	if errors.Is(err, client.ErrNoLDevID) {
		printf("serial %s: %v; nothing to renew", o.serial, err)
		return nil
	}
	if err != nil {
		return err
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
