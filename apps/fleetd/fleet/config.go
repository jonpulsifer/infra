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
	"log"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/jonpulsifer/infra/apps/fleetd/bmc"
	"github.com/jonpulsifer/infra/apps/fleetd/classes"
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
	Site      string
	Namespace string
	// Classes is the class table: the Template and installer image of each
	// class a Workflow can run.
	Classes       classes.Table
	HookOSURL     string
	HookOSCmdline string
	Interval      time.Duration
	WorkflowTTL   time.Duration
	BMCSecrets    map[string]string
	AMTPort       int
	// Installs maps each class the fleet renders to its Talos installer
	// image, from the class inputs.
	Installs map[string]string
	// ImageInstalls names each image class whose provision installs: the
	// class table carries its whole image, FLEET_INSTALLS is on and SeedURL
	// is set.
	ImageInstalls map[string]bool
	// SeedURL is where an image class's install, or the installed node's
	// first boot, fetches its seed: the boot listener's /seed, from
	// FLEET_SEED_URL. Without it no image class installs.
	SeedURL string
	// Bootstrap is the address of the control plane the Talos root
	// bootstraps etcd on, from FLEET_BOOTSTRAP_ADDRESS.
	Bootstrap string
	// ControlPlaneClasses are the classes the class inputs render as a
	// control plane, beside ControlPlaneClass.
	ControlPlaneClasses map[string]bool
	// AutoProvision lets an admitted device with a class and an address,
	// which never ran a Workflow, start its provision without the owner.
	AutoProvision bool
	// BMCJobWait is how long a pass waits for the BMC to power a machine
	// off: the Rufio Job that stops a run, or in native mode the stop and
	// the power-off a netboot starts with.
	BMCJobWait time.Duration
	// BMCMode is who drives a device's BMC: BMCRufio, through Rufio's
	// Machine and Job objects and Tinkerbell's boot jobs, or BMCNative,
	// fleetd itself, from FLEET_BMC.
	BMCMode string
}

// The BMC modes FLEET_BMC names.
const (
	BMCRufio  = "rufio"
	BMCNative = "native"
)

// NativeBMC says whether fleetd drives the BMCs itself.
func (c Config) NativeBMC() bool { return c.BMCMode == BMCNative }

// LoadConfig reads the FLEET_* environment that README.md lists.
func LoadConfig() (Config, error) {
	c := Config{
		Site:          env("FLEET_SITE", "folly"),
		Namespace:     env("FLEET_NAMESPACE", "tinkerbell"),
		HookOSURL:     os.Getenv("FLEET_HOOKOS_URL"),
		HookOSCmdline: os.Getenv("FLEET_HOOKOS_CMDLINE"),
		BMCSecrets:    map[string]string{"amt": "bmc-amt"},
		AMTPort:       16992,
		BMCJobWait:    30 * time.Second,
		BMCMode:       env("FLEET_BMC", BMCRufio),
	}
	if c.BMCMode != BMCRufio && c.BMCMode != BMCNative {
		return c, fmt.Errorf("FLEET_BMC %q is neither %s nor %s", c.BMCMode, BMCRufio, BMCNative)
	}
	for _, k := range []string{"FLEET_HOOKOS_URL", "FLEET_HOOKOS_CMDLINE"} {
		if _, err := required(k); err != nil {
			return c, err
		}
	}
	var err error
	classFile, err := required("FLEET_CLASSES")
	if err != nil {
		return c, err
	}
	if c.Classes, err = classes.Load(classFile); err != nil {
		return c, err
	}
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
	if v := os.Getenv("FLEET_SEED_URL"); v != "" {
		u, err := url.Parse(v)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
			return c, fmt.Errorf("FLEET_SEED_URL %q is not an http(s) URL without a query", v)
		}
		c.SeedURL = v
	}
	return c, nil
}

// LoadBMC reads native mode's environment: FLEET_BMC_AMT_CREDENTIAL_FILE,
// the AMT credential, and FLEET_BMC_STATE_FILE, where fleetd keeps each
// run's BMC record. In rufio mode it returns nils and reads nothing.
func LoadBMC(cfg Config) (func(Device) (bmc.BMC, error), *Runs, error) {
	if !cfg.NativeBMC() {
		return nil, nil, nil
	}
	credFile, err := required("FLEET_BMC_AMT_CREDENTIAL_FILE")
	if err != nil {
		return nil, nil, fmt.Errorf("FLEET_BMC=native: %w", err)
	}
	state, err := required("FLEET_BMC_STATE_FILE")
	if err != nil {
		return nil, nil, fmt.Errorf("FLEET_BMC=native: %w", err)
	}
	cred, err := bmc.LoadCredential(credFile)
	if err != nil {
		return nil, nil, fmt.Errorf("FLEET_BMC_AMT_CREDENTIAL_FILE: %w", err)
	}
	runs := &Runs{File: state}
	if _, _, err := runs.Get(""); err != nil {
		return nil, nil, fmt.Errorf("FLEET_BMC_STATE_FILE: %w", err)
	}
	dialer := &bmc.Dialer{Credentials: map[string]bmc.Credential{"amt": cred}, AMTPort: cfg.AMTPort, Timeout: 20 * time.Second}
	return func(d Device) (bmc.BMC, error) { return dialer.Dial(d.BMCType, d.BMCAddress) }, runs, nil
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
	if dir := os.Getenv("FLEET_CONFIG_DIR"); dir != "" {
		c.Ledger.File = filepath.Join(dir, joinLedgerFile)
	}
	return c, nil
}

// LoadInstaller reads the render's environment. The Talos renderer runs only
// with all three of FLEET_CLASS_INPUTS, FLEET_WORKER_SECRETS and
// FLEET_TALOSCTL; without them no Talos class renders, and no install code
// is answered for one. A Talos Workflow installs only with the renderer and
// FLEET_INSTALLS=true; an image class's installs with FLEET_INSTALLS=true, a
// whole image in the class table and FLEET_SEED_URL, and needs no Talos
// renderer.
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
		Classes: cfg.Classes,
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
	// FLEET_SEED_INPUTS lets a seed class render; a Talos class needs the
	// three below.
	if seeds := os.Getenv("FLEET_SEED_INPUTS"); seeds != "" {
		inputs, err := LoadSeedInputs(seeds)
		if err != nil {
			return nil, err
		}
		in.Seeds = &SeedRenderer{Inputs: inputs, Classes: cfg.Classes}
	}
	// FLEET_INSTALLS is the switch for the install itself: off, no Workflow
	// installs, and nothing renders, since no run asks for a config.
	installs := env("FLEET_INSTALLS", "false") == "true"
	if installs {
		cfg.ImageInstalls = imageInstalls(cfg.Classes, cfg.SeedURL)
	}
	inputsFile, workers, bin := os.Getenv("FLEET_CLASS_INPUTS"), os.Getenv("FLEET_WORKER_SECRETS"), os.Getenv("FLEET_TALOSCTL")
	if inputsFile == "" && workers == "" && bin == "" {
		return in, nil
	}
	if inputsFile == "" || workers == "" || bin == "" {
		return nil, fmt.Errorf("FLEET_CLASS_INPUTS, FLEET_WORKER_SECRETS and FLEET_TALOSCTL go together")
	}
	if in.TTL+JoinTokenGrace > JoinTokenMaxLifetime {
		return nil, fmt.Errorf("FLEET_CONFIG_TTL must be at most %s: a worker's bootstrap token lives for it plus %s, and the cluster admits none for more than %s", JoinTokenMaxLifetime-JoinTokenGrace, JoinTokenGrace, JoinTokenMaxLifetime)
	}
	inputs, err := LoadClassInputs(inputsFile)
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
	if !installs {
		return in, nil
	}
	cfg.Installs = map[string]string{}
	for class, ci := range inputs {
		if ci.MachineType == "worker" || in.ControlPlanes {
			cfg.Installs[class] = ci.InstallerImage
		}
	}
	// The class table pins its images by digest, so its image wins over the
	// class inputs', which carry the Talos root's mutable tag. A class the
	// inputs render but leave out, such as a control plane without the
	// bundle, stays out.
	for class, c := range cfg.Classes {
		_, rendered := inputs[class]
		_, installs := cfg.Installs[class]
		if c.InstallerImage != "" && (installs || !rendered) {
			cfg.Installs[class] = c.InstallerImage
		}
	}
	for class, image := range cfg.Installs {
		if !classes.PinnedByDigest(image) {
			return nil, fmt.Errorf("class %s installs %q, which is not pinned by digest: pin installer_image in classes.json", class, image)
		}
	}
	return in, nil
}

// imageInstalls names the image classes whose provision installs: each with
// a whole image in the table, when the seed URL is set. Without the seed URL
// no image class installs, and the log says so once.
func imageInstalls(table classes.Table, seedURL string) map[string]bool {
	installs := map[string]bool{}
	var whole []string
	for name, c := range table {
		if c.Installs() {
			whole = append(whole, name)
		}
	}
	if len(whole) == 0 {
		return installs
	}
	if seedURL == "" {
		sort.Strings(whole)
		log.Printf("FLEET_SEED_URL is not set, so the image classes %s install nothing: their install writes the seed URL to the disk", strings.Join(whole, ", "))
		return installs
	}
	for _, name := range whole {
		installs[name] = true
	}
	return installs
}
