// fleet-controller turns NetBox's view of a site's Kubernetes nodes into
// Tinkerbell objects. It owns the Hardware, Machine and Workflow objects of
// one namespace: each device NetBox exports gets a Hardware and, with a BMC, a
// Machine; a device whose desired_action is set gets a Workflow; a device in
// decommissioning gets a wipe and ends offline. It reconciles on a timer and
// when NetBox's webhook rings, and every pass is a pure "make it so".
//
// A machine NetBox does not know phones home to POST /intake from HookOS and
// gets an attest-only Workflow; once talos-attest has made it a staged,
// attested device, the pass binds it to a stub's name and address, the
// model's class and the switch port UniFi reports, and provisions it.
//
// A device whose interface has no cable gets one to the rack port UniFi reports.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
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
	// Installs maps each class the controller renders to its Talos
	// installer image, from the class inputs.
	Installs map[string]string
	// Bootstrap is the address of the control plane the Talos root
	// bootstraps etcd on, set with the control-plane renders.
	Bootstrap string
	// ControlPlaneClasses are the classes the class inputs render as a
	// control plane, beside ControlPlaneClass.
	ControlPlaneClasses map[string]bool
	// AutoProvision lets a bound intake with a class and an address start
	// its provision without the owner.
	AutoProvision bool
	// Models maps an SMBIOS model to the class, BMC and disk of its intake.
	Models map[string]Model
	// NodePrefix is the prefix an intake's address comes from, and
	// NodeReserved the addresses in it that never go to a node.
	NodePrefix   string
	NodeReserved map[string]bool
	// IntakeTTL is the age at which an intake no device holds is deleted.
	IntakeTTL time.Duration
	// IntakePort is the switch port of the prep station, where every
	// machine intakes; UniFi seeing a machine there says nothing of its
	// rack port.
	IntakePort int
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
	c.AutoProvision = env("FLEET_AUTO_PROVISION", "false") == "true"
	if c.Models, err = ParseModels(os.Getenv("FLEET_MODEL_MAP")); err != nil {
		return c, err
	}
	if c.IntakeTTL, err = time.ParseDuration(env("FLEET_INTAKE_TTL", "24h")); err != nil || c.IntakeTTL <= 0 {
		return c, fmt.Errorf("FLEET_INTAKE_TTL must be a positive duration")
	}
	if c.IntakePort, err = strconv.Atoi(env("FLEET_INTAKE_PORT", "24")); err != nil || c.IntakePort < 0 {
		return c, fmt.Errorf("FLEET_INTAKE_PORT must be a port number, or 0 for none")
	}
	c.NodePrefix = os.Getenv("FLEET_NODE_PREFIX")
	if c.NodePrefix != "" {
		p, err := netip.ParsePrefix(c.NodePrefix)
		if err != nil || !p.Addr().Is4() || p != p.Masked() {
			return c, fmt.Errorf("FLEET_NODE_PREFIX %q is not an IPv4 network prefix", c.NodePrefix)
		}
	}
	c.NodeReserved = map[string]bool{}
	for _, a := range strings.Split(os.Getenv("FLEET_NODE_RESERVED"), ",") {
		if a = strings.TrimSpace(a); a == "" {
			continue
		}
		if _, err := netip.ParseAddr(a); err != nil {
			return c, fmt.Errorf("FLEET_NODE_RESERVED: %w", err)
		}
		c.NodeReserved[a] = true
	}
	return c, nil
}

// loadUniFi reads the optional UniFi client: FLEET_UNIFI_URL and
// FLEET_UNIFI_API_KEY_FILE go together.
func loadUniFi() (*UniFi, error) {
	u, keyFile := os.Getenv("FLEET_UNIFI_URL"), os.Getenv("FLEET_UNIFI_API_KEY_FILE")
	if u == "" && keyFile == "" {
		return nil, nil
	}
	if u == "" || keyFile == "" {
		return nil, fmt.Errorf("FLEET_UNIFI_URL and FLEET_UNIFI_API_KEY_FILE go together")
	}
	key, err := readSecret(keyFile)
	if err != nil {
		return nil, fmt.Errorf("UniFi API key: %w", err)
	}
	return &UniFi{URL: u, Key: key, Site: env("FLEET_UNIFI_SITE", "default"), Client: &http.Client{Timeout: 15 * time.Second}}, nil
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

	metrics := NewMetrics()
	installer, err := loadInstaller(&cfg, netbox, kube, metrics)
	if err != nil {
		return err
	}
	unifi, err := loadUniFi()
	if err != nil {
		return err
	}
	r := &Reconciler{Config: cfg, NetBox: netbox, Kube: kube, Metrics: metrics, UniFi: unifi, Now: time.Now}
	intake := &Intake{
		Config: &r.Config, NetBox: netbox, Kube: kube, Metrics: metrics, Now: time.Now,
		PerMAC: 10 * time.Minute, PerSource: 10, Global: 20, Window: time.Hour,
	}
	trigger := make(chan string, 1)

	mux := http.NewServeMux()
	mux.Handle("POST /webhook", &Webhook{Secret: secret, Trigger: trigger, Metrics: r.Metrics})
	mux.Handle("POST /render", installer)
	mux.Handle("POST /intake", intake)
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
		ReadTimeout:       15 * time.Second,
		// A render waits on talosctl for up to 20 seconds.
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  2 * time.Minute,
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
	if installer.Renderer != nil {
		go installer.Run(ctx, installer.TailInterval, 15)
	}

	select {
	case <-ctx.Done():
	case err := <-errc:
		return err
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}

// loadInstaller reads the render's environment. The renderer runs only with
// all three of FLEET_CLASS_INPUTS, FLEET_WORKER_SECRETS and FLEET_TALOSCTL;
// without them, or without FLEET_ATTEST_SECRET_FILE, /render answers 503.
// A Workflow installs only with the renderer and FLEET_INSTALLS=true.
//
// FLEET_CONTROLPLANE_BUNDLE, the full secrets bundle, lets a control-plane
// class render and install too. It needs the renderer and
// FLEET_BOOTSTRAP_ADDRESS, the control plane the Talos root bootstraps,
// which never installs from here.
func loadInstaller(cfg *Config, netbox *NetBox, kube *Kube, metrics *Metrics) (*Installer, error) {
	stateDir := env("FLEET_STATE_DIR", "/var/lib/fleet-controller")
	in := &Installer{
		Site:   cfg.Site,
		NetBox: netbox,
		Kube:   kube,
		Store: &Store{
			Dir:     filepath.Join(stateDir, "talos"),
			Burned:  filepath.Join(stateDir, "talos-burned.json"),
			BurnFor: 24 * time.Hour,
		},
		Tail: &Tail{
			Path:   env("FLEET_CONFIG_LOG", "/var/log/nginx/talos-config.log"),
			Offset: filepath.Join(stateDir, "talos-config.tail.json"),
		},
		Metrics:      metrics,
		Now:          time.Now,
		TailInterval: 2 * time.Second,
	}
	var err error
	if in.TTL, err = time.ParseDuration(env("FLEET_CONFIG_TTL", "2h")); err != nil || in.TTL <= 0 {
		return nil, fmt.Errorf("FLEET_CONFIG_TTL must be a positive duration")
	}
	if f := os.Getenv("FLEET_ATTEST_SECRET_FILE"); f != "" {
		s, err := readSecret(f)
		if err != nil {
			return nil, fmt.Errorf("attest secret: %w", err)
		}
		in.Secret = []byte(s)
	}
	classes, workers, bin := os.Getenv("FLEET_CLASS_INPUTS"), os.Getenv("FLEET_WORKER_SECRETS"), os.Getenv("FLEET_TALOSCTL")
	if classes == "" && workers == "" && bin == "" {
		return in, nil
	}
	if classes == "" || workers == "" || bin == "" {
		return nil, fmt.Errorf("FLEET_CLASS_INPUTS, FLEET_WORKER_SECRETS and FLEET_TALOSCTL go together")
	}
	inputs, err := LoadClassInputs(classes)
	if err != nil {
		return nil, err
	}
	worker, err := LoadWorkerSecrets(workers)
	if err != nil {
		return nil, err
	}
	// talos-attest gives up on /render after 30 seconds.
	t := &Talosctl{Bin: bin, Worker: worker, Inputs: inputs, Timeout: 20 * time.Second}
	in.Renderer, in.Prepare = t, t.Init
	cfg.ControlPlaneClasses = map[string]bool{}
	for class, ci := range inputs {
		if ci.MachineType == "controlplane" {
			cfg.ControlPlaneClasses[class] = true
		}
	}
	if bundle := os.Getenv("FLEET_CONTROLPLANE_BUNDLE"); bundle != "" {
		if err := LoadBundle(bundle, worker); err != nil {
			return nil, err
		}
		boot, err := netip.ParseAddr(os.Getenv("FLEET_BOOTSTRAP_ADDRESS"))
		if err != nil {
			return nil, fmt.Errorf("FLEET_CONTROLPLANE_BUNDLE needs FLEET_BOOTSTRAP_ADDRESS, the control plane the Talos root bootstraps: %w", err)
		}
		if in.ControlPlaneTTL, err = time.ParseDuration(env("FLEET_CONTROLPLANE_CONFIG_TTL", "30m")); err != nil || in.ControlPlaneTTL <= 0 {
			return nil, fmt.Errorf("FLEET_CONTROLPLANE_CONFIG_TTL must be a positive duration")
		}
		t.BundlePath, in.ControlPlanes, in.Bootstrap = bundle, true, boot.String()
		cfg.Bootstrap = in.Bootstrap
	}
	// FLEET_INSTALLS is the switch for the install itself: off, no Workflow
	// installs, and /render refuses every call, since no run asks for one.
	if env("FLEET_INSTALLS", "false") != "true" {
		return in, nil
	}
	cfg.Installs = map[string]string{}
	for class, ci := range inputs {
		if ci.MachineType == "worker" || in.ControlPlanes {
			cfg.Installs[class] = ci.InstallerImage
		}
	}
	return in, nil
}
