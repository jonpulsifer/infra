// Package fleet turns NetBox's view of a site's Kubernetes nodes into
// Tinkerbell objects. It owns the Hardware, Machine and Workflow objects of
// one namespace: each device NetBox exports gets a Hardware and, with a BMC, a
// Machine; a device whose desired_action is set gets a Workflow; a device in
// decommissioning gets a wipe and ends offline. It reconciles on a timer and
// when NetBox's webhook rings, and every pass is a pure "make it so".
//
// Attestation is the intake: HookOS attests on every boot, and an intake
// pass's signed confirm calls Admit in the same process. Admit binds the
// planned device the pass names to the model's class, its address and the
// switch port the pass attested, starts its provision Workflow, and renders
// its Talos config under the install code the confirm answers. The config is
// served once from memory at GET /talos/config.
//
// A node the verifier quarantined is cordoned through the cluster's own API.
package fleet

import (
	"fmt"
	"net/netip"
	"os"
	"strings"
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

// ReadSecret reads a secret file and trims its surrounding whitespace.
func ReadSecret(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// Config is the fleet's environment.
type Config struct {
	Site          string
	Namespace     string
	Template      string
	HookOSURL     string
	HookOSCmdline string
	Interval      time.Duration
	WorkflowTTL   time.Duration
	BMCSecrets    map[string]string
	AMTPort       int
	// Installs maps each class the fleet renders to its Talos installer
	// image, from the class inputs.
	Installs map[string]string
	// Bootstrap is the address of the control plane the Talos root
	// bootstraps etcd on, from FLEET_BOOTSTRAP_ADDRESS.
	Bootstrap string
	// ControlPlaneClasses are the classes the class inputs render as a
	// control plane, beside ControlPlaneClass.
	ControlPlaneClasses map[string]bool
	// AutoProvision lets an admitted device with a class and an address,
	// which never ran a Workflow, start its provision without the owner.
	AutoProvision bool
}

// LoadConfig reads the FLEET_* environment that README.md lists.
func LoadConfig() (Config, error) {
	c := Config{
		Site:          env("FLEET_SITE", "folly"),
		Namespace:     env("FLEET_NAMESPACE", "tinkerbell"),
		Template:      env("FLEET_TEMPLATE", "provision"),
		HookOSURL:     os.Getenv("FLEET_HOOKOS_URL"),
		HookOSCmdline: os.Getenv("FLEET_HOOKOS_CMDLINE"),
		BMCSecrets:    map[string]string{"amt": "bmc-amt"},
		AMTPort:       16992,
	}
	for _, k := range []string{"FLEET_HOOKOS_URL", "FLEET_HOOKOS_CMDLINE"} {
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
	// FLEET_BMC_SECRETS maps a NetBox bmc_type to the Secret Rufio reads: "amt=bmc-amt".
	if v := os.Getenv("FLEET_BMC_SECRETS"); v != "" {
		for _, pair := range strings.Split(v, ",") {
			k, s, ok := strings.Cut(strings.TrimSpace(pair), "=")
			if !ok || k == "" || s == "" {
				return c, fmt.Errorf("FLEET_BMC_SECRETS entry %q is not type=secret", pair)
			}
			c.BMCSecrets[k] = s
		}
	}
	c.AutoProvision = env("FLEET_AUTO_PROVISION", "false") == "true"
	if v := os.Getenv("FLEET_BOOTSTRAP_ADDRESS"); v != "" {
		a, err := netip.ParseAddr(v)
		if err != nil {
			return c, fmt.Errorf("FLEET_BOOTSTRAP_ADDRESS %q is not an address: %w", v, err)
		}
		c.Bootstrap = a.String()
	}
	return c, nil
}

// LoadCluster reads the site cluster's API: FLEET_CLUSTER_SERVER, its CA in
// FLEET_CLUSTER_CA_FILE and a ServiceAccount token in FLEET_CLUSTER_TOKEN_FILE,
// all three or none. Without them no node is cordoned, and a quarantine is
// journaled for the owner to cordon.
func LoadCluster() (*Cluster, error) {
	server, ca, token := os.Getenv("FLEET_CLUSTER_SERVER"), os.Getenv("FLEET_CLUSTER_CA_FILE"), os.Getenv("FLEET_CLUSTER_TOKEN_FILE")
	if server == "" && ca == "" && token == "" {
		return nil, nil
	}
	if server == "" || ca == "" || token == "" {
		return nil, fmt.Errorf("FLEET_CLUSTER_SERVER, FLEET_CLUSTER_CA_FILE and FLEET_CLUSTER_TOKEN_FILE go together")
	}
	c, err := NewCluster(server, ca, token)
	if err != nil {
		return nil, fmt.Errorf("cluster API client: %w", err)
	}
	return c, nil
}

// LoadInstaller reads the render's environment. The renderer runs only with
// all three of FLEET_CLASS_INPUTS, FLEET_WORKER_SECRETS and FLEET_TALOSCTL;
// without them nothing renders, and no install code is answered. A Workflow
// installs only with the renderer and FLEET_INSTALLS=true.
//
// FLEET_CONTROLPLANE_BUNDLE, the full secrets bundle, lets a control-plane
// class render and install too. It needs the renderer and
// FLEET_BOOTSTRAP_ADDRESS, the control plane the Talos root bootstraps,
// which never installs from here.
func LoadInstaller(cfg *Config, netbox *NetBox, kube *Kube, metrics *Metrics) (*Installer, error) {
	in := &Installer{
		Site:    cfg.Site,
		NetBox:  netbox,
		Kube:    kube,
		Configs: &Configs{Dir: os.Getenv("FLEET_CONFIG_DIR")},
		Metrics: metrics,
		Now:     time.Now,
	}
	if err := in.Configs.Load(); err != nil {
		return nil, fmt.Errorf("FLEET_CONFIG_DIR: %w", err)
	}
	var err error
	if in.TTL, err = time.ParseDuration(env("FLEET_CONFIG_TTL", "2h")); err != nil || in.TTL <= 0 {
		return nil, fmt.Errorf("FLEET_CONFIG_TTL must be a positive duration")
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
	// The verifier gives up on the install after 30 seconds.
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
	// installs, and nothing renders, since no run asks for a config.
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
