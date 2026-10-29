// fleet-controller turns NetBox's view of a site's Kubernetes nodes into
// Tinkerbell objects. It owns the Hardware, Machine and Workflow objects of
// one namespace: each device NetBox exports gets a Hardware and, with a BMC, a
// Machine; a device whose desired_action is set gets a Workflow; a device in
// decommissioning gets a wipe and ends offline. It reconciles on a timer and
// when NetBox's webhook rings, and every pass is a pure "make it so".
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func required(key string) (string, error) {
	v := os.Getenv(key)
	if v == "" {
		return "", fmt.Errorf("%s is required", key)
	}
	return v, nil
}

func readSecret(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Config is the controller's environment.
type Config struct {
	Site            string
	Namespace       string
	Template        string
	HookOSURL       string
	HookOSCmdline   string
	AttestURL       string
	NTPServer       string
	Interval        time.Duration
	WorkflowTTL     time.Duration
	BMCSecrets      map[string]string
	RedfishPort     int
	RedfishInsecure bool
	AMTPort         int
}

func loadConfig() (Config, error) {
	c := Config{
		Site:          env("FLEET_SITE", "folly"),
		Namespace:     env("FLEET_NAMESPACE", "tinkerbell"),
		Template:      env("FLEET_TEMPLATE", "provision"),
		HookOSURL:     os.Getenv("FLEET_HOOKOS_URL"),
		HookOSCmdline: os.Getenv("FLEET_HOOKOS_CMDLINE"),
		AttestURL:     os.Getenv("FLEET_ATTEST_URL"),
		NTPServer:     os.Getenv("FLEET_NTP_SERVER"),
		BMCSecrets:    map[string]string{"amt": "bmc-amt", "redfish": "bmc-redfish"},
		RedfishPort:   443,
		AMTPort:       16992,
	}
	for _, k := range []string{"FLEET_HOOKOS_URL", "FLEET_HOOKOS_CMDLINE", "FLEET_ATTEST_URL", "FLEET_NTP_SERVER"} {
		if _, err := required(k); err != nil {
			return c, err
		}
	}
	var err error
	if c.Interval, err = time.ParseDuration(env("FLEET_INTERVAL", "2m")); err != nil || c.Interval <= 0 {
		return c, fmt.Errorf("FLEET_INTERVAL must be a positive duration")
	}
	if c.WorkflowTTL, err = time.ParseDuration(env("FLEET_WORKFLOW_TTL", "168h")); err != nil || c.WorkflowTTL <= 0 {
		return c, fmt.Errorf("FLEET_WORKFLOW_TTL must be a positive duration")
	}
	// FLEET_BMC_SECRETS maps a NetBox bmc_type to the Secret Rufio reads: "amt=bmc-amt,redfish=bmc-redfish".
	if v := os.Getenv("FLEET_BMC_SECRETS"); v != "" {
		for _, pair := range strings.Split(v, ",") {
			k, s, ok := strings.Cut(strings.TrimSpace(pair), "=")
			if !ok || k == "" || s == "" {
				return c, fmt.Errorf("FLEET_BMC_SECRETS entry %q is not type=secret", pair)
			}
			c.BMCSecrets[k] = s
		}
	}
	if v := os.Getenv("FLEET_REDFISH_PORT"); v != "" {
		if c.RedfishPort, err = strconv.Atoi(v); err != nil {
			return c, fmt.Errorf("FLEET_REDFISH_PORT: %w", err)
		}
	}
	c.RedfishInsecure = env("FLEET_REDFISH_INSECURE_TLS", "false") == "true"
	return c, nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	netboxURL, err := required("FLEET_NETBOX_URL")
	if err != nil {
		return err
	}
	tokenFile, err := required("FLEET_NETBOX_TOKEN_FILE")
	if err != nil {
		return err
	}
	token, err := readSecret(tokenFile)
	if err != nil {
		return fmt.Errorf("NetBox token: %w", err)
	}
	netbox := &NetBox{URL: netboxURL, Token: token, Client: &http.Client{Timeout: 30 * time.Second}}

	kube, err := NewKube(
		env("FLEET_KUBE_SERVER", "https://localhost:6443"),
		env("FLEET_KUBE_CA_FILE", "/etc/tinkerbell/ca.crt"),
		env("FLEET_KUBE_CERT_FILE", "/etc/tinkerbell/admin.crt"),
		env("FLEET_KUBE_KEY_FILE", "/etc/tinkerbell/admin.key"),
		cfg.Namespace,
	)
	if err != nil {
		return fmt.Errorf("Tinkerbell API client: %w", err)
	}

	var secret []byte
	if f := os.Getenv("FLEET_WEBHOOK_SECRET_FILE"); f != "" {
		s, err := readSecret(f)
		if err != nil {
			return fmt.Errorf("webhook secret: %w", err)
		}
		secret = []byte(s)
	}

	r := &Reconciler{Config: cfg, NetBox: netbox, Kube: kube, Metrics: NewMetrics(), Now: time.Now}
	trigger := make(chan string, 1)

	mux := http.NewServeMux()
	mux.Handle("POST /webhook", &Webhook{Secret: secret, Trigger: trigger, Metrics: r.Metrics})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		if ok, why := r.Healthy(3 * cfg.Interval); !ok {
			http.Error(w, why, http.StatusServiceUnavailable)
			return
		}
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("GET /metrics", r.Metrics)
	srv := &http.Server{
		Addr:              env("FLEET_WEBHOOK_ADDR", ":8446"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		log.Printf("listening on %s", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()
	go r.Loop(ctx, trigger)

	select {
	case <-ctx.Done():
	case err := <-errc:
		return err
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}
