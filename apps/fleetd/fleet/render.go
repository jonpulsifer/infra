package fleet

// .github/scripts/talos-render-parity.sh checks the renderer against the Talos
// root.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ClassInputs is one class's entry in the Talos root's class_inputs output:
// everything a fresh install's config is rendered from except the node's own
// facts and the secrets. The patches are in the order the root applies them.
type ClassInputs struct {
	MachineType       string `json:"machine_type"`
	ClusterName       string `json:"cluster_name"`
	ClusterEndpoint   string `json:"cluster_endpoint"`
	TalosContract     string `json:"talos_contract"`
	KubernetesVersion string `json:"kubernetes_version"`
	InstallerImage    string `json:"installer_image"`
	DNSZone           string `json:"dns_zone"`
	// ConfigPatches come before the node's own document: the cluster's, and
	// the control plane's for that machine type.
	ConfigPatches []string `json:"config_patches"`
	// TPMPatches follow the node document on a node with a TPM 2.0.
	TPMPatches []string `json:"tpm_patches"`
	// ClassPatches come last: the class's own, such as its EPHEMERAL size.
	ClassPatches []string `json:"class_patches"`
	// Labels are the class's node labels; TPMLabels join them on a TPM node.
	Labels    map[string]string `json:"labels"`
	TPMLabels map[string]string `json:"tpm_labels"`
	// NodeNetwork is how the node document gives a node its static address,
	// or nil for a cluster whose nodes take theirs by DHCP.
	NodeNetwork *NodeNetwork `json:"node_network"`
}

// NodeNetwork is the link, prefix length and gateway of a node's static
// address; the address itself is the node's own.
type NodeNetwork struct {
	Link         string `json:"link"`
	PrefixLength int    `json:"prefix_length"`
	Gateway      string `json:"gateway"`
}

func (c ClassInputs) validate() error {
	if c.MachineType != "controlplane" && c.MachineType != "worker" {
		return fmt.Errorf("machine_type %q is neither controlplane nor worker", c.MachineType)
	}
	for name, v := range map[string]string{
		"cluster_name": c.ClusterName, "cluster_endpoint": c.ClusterEndpoint,
		"talos_contract": c.TalosContract, "kubernetes_version": c.KubernetesVersion,
		"installer_image": c.InstallerImage, "dns_zone": c.DNSZone,
	} {
		if v == "" {
			return fmt.Errorf("%s is empty", name)
		}
	}
	if n := c.NodeNetwork; n != nil {
		gw, err := netip.ParseAddr(n.Gateway)
		if n.Link == "" || n.PrefixLength < 1 || n.PrefixLength > 30 || err != nil || !gw.Is4() {
			return fmt.Errorf("node_network %+v needs a link, an IPv4 prefix length of 1 to 30 and an IPv4 gateway", *n)
		}
	}
	return nil
}

// LoadClassInputs reads the file that `mise run render-class-inputs` writes.
// A class whose inputs do not validate is refused at load.
func LoadClassInputs(path string) (map[string]ClassInputs, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var inputs map[string]ClassInputs
	if err := json.Unmarshal(raw, &inputs); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for class, in := range inputs {
		if err := in.validate(); err != nil {
			return nil, fmt.Errorf("%s: class %s: %w", path, class, err)
		}
	}
	return inputs, nil
}

// WorkerSecrets is what a worker's config carries from the cluster's secrets
// bundle: tokens, identifiers and CA certificates, never a CA key. The file
// has the bundle's own shape, so the full bundle is a valid superset.
type WorkerSecrets struct {
	Cluster struct {
		ID     string `yaml:"id"`
		Secret string `yaml:"secret"`
	} `yaml:"cluster"`
	Secrets struct {
		BootstrapToken string `yaml:"bootstraptoken"`
	} `yaml:"secrets"`
	TrustdInfo struct {
		Token string `yaml:"token"`
	} `yaml:"trustdinfo"`
	Certs struct {
		K8s struct {
			Crt string `yaml:"crt"`
		} `yaml:"k8s"`
		OS struct {
			Crt string `yaml:"crt"`
		} `yaml:"os"`
	} `yaml:"certs"`
}

// values lists the secrets a worker config carries, in the form the rendered
// config prints them: the tokens and identifiers verbatim, the os CA as the
// bundle's base64, and the Kubernetes CA as the PEM that acceptedCAs quotes.
func (w WorkerSecrets) values() (map[string]string, error) {
	k8s, err := base64.StdEncoding.DecodeString(w.Certs.K8s.Crt)
	if err != nil {
		return nil, fmt.Errorf("certs.k8s.crt is not base64: %w", err)
	}
	v := map[string]string{
		"cluster.id":             w.Cluster.ID,
		"cluster.secret":         w.Cluster.Secret,
		"secrets.bootstraptoken": w.Secrets.BootstrapToken,
		"trustdinfo.token":       w.TrustdInfo.Token,
		"certs.os.crt":           w.Certs.OS.Crt,
		"certs.k8s.crt (PEM)":    strings.TrimSpace(string(k8s)),
	}
	for name, s := range v {
		if s == "" {
			return nil, fmt.Errorf("%s is empty", name)
		}
	}
	return v, nil
}

func parseWorkerSecrets(b []byte) (WorkerSecrets, error) {
	var w WorkerSecrets
	if err := yaml.Unmarshal(b, &w); err != nil {
		return w, err
	}
	_, err := w.values()
	return w, err
}

// LoadWorkerSecrets reads the worker subset, or the full bundle.
func LoadWorkerSecrets(path string) (WorkerSecrets, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return WorkerSecrets{}, err
	}
	w, err := parseWorkerSecrets(b)
	if err != nil {
		return w, fmt.Errorf("%s: %w", path, err)
	}
	return w, nil
}

// LoadBundle checks the full secrets bundle a control-plane render reads:
// every CA key and the secretbox secret are present, and its worker values
// are the worker secrets', so both files are of one cluster. A control plane
// rendered from a worker subset, or from another cluster's bundle, would
// never join.
func LoadBundle(path string, worker WorkerSecrets) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var full struct {
		Secrets struct {
			Secretbox string `yaml:"secretboxencryptionsecret"`
		} `yaml:"secrets"`
		Certs map[string]struct {
			Key string `yaml:"key"`
		} `yaml:"certs"`
	}
	if err := yaml.Unmarshal(b, &full); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	if full.Secrets.Secretbox == "" {
		return fmt.Errorf("%s: secrets.secretboxencryptionsecret is empty", path)
	}
	for _, ca := range []string{"etcd", "k8s", "k8saggregator", "k8sserviceaccount", "os"} {
		if full.Certs[ca].Key == "" {
			return fmt.Errorf("%s: certs.%s.key is empty; a control plane needs the full bundle", path, ca)
		}
	}
	own, err := parseWorkerSecrets(b)
	if err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	have, _ := own.values()
	want, err := worker.values()
	if err != nil {
		return fmt.Errorf("the worker secrets: %w", err)
	}
	for name, v := range want {
		if have[name] != v {
			return fmt.Errorf("%s: %s differs from the worker secrets'; the two are not of one cluster", path, name)
		}
	}
	return nil
}

// Node is what a render takes from a NetBox device: its name, class,
// install disk, TPM spec version ("2.0" for a node that seals its disks) and
// primary IPv4 address.
type Node struct {
	Name    string
	Class   string
	Disk    string
	TPM     string
	Address string
}

// Renderer turns a node into its machine config.
type Renderer interface {
	Classes() []string
	// MachineType is a class's controlplane or worker, or "" for a class the
	// inputs do not name.
	MachineType(class string) string
	Render(ctx context.Context, n Node) ([]byte, error)
}

// ErrNoBundle is a control-plane render on a server that holds only the
// worker secrets.
var ErrNoBundle = errors.New("a control-plane config needs the full secrets bundle, which this server does not hold")

// ErrNoClass is a node whose class the class inputs do not name.
var ErrNoClass = errors.New("the node's class is not in the class inputs")

// Talosctl renders with `talosctl gen config --with-secrets`, the recipe that
// matches the Talos provider byte for byte. A worker is rendered from a
// throwaway bundle, and the six values a worker config carries are then
// replaced with the real ones, so the server needs no CA key for it. A
// control plane is rendered from the full bundle at BundlePath, as the Talos
// root renders it; without one it is refused.
type Talosctl struct {
	Bin        string
	BundlePath string
	Worker     WorkerSecrets
	Inputs     map[string]ClassInputs
	Timeout    time.Duration

	decoy       []byte
	decoyValues map[string]string
}

// Init makes the throwaway bundle. The server keeps one per process.
func (t *Talosctl) Init(ctx context.Context) error {
	out, err := t.run(ctx, nil, "gen", "secrets", "-o", "-")
	if err != nil {
		return fmt.Errorf("talosctl gen secrets: %w", err)
	}
	d, err := parseWorkerSecrets(out)
	if err != nil {
		return fmt.Errorf("the throwaway bundle: %w", err)
	}
	t.decoy = out
	t.decoyValues, _ = d.values()
	return nil
}

func (t *Talosctl) MachineType(class string) string { return t.Inputs[class].MachineType }

func (t *Talosctl) Classes() []string {
	classes := make([]string, 0, len(t.Inputs))
	for c := range t.Inputs {
		classes = append(classes, c)
	}
	sort.Strings(classes)
	return classes
}

var diskPattern = regexp.MustCompile(`^/dev/[A-Za-z0-9/_.-]+$`)

func (t *Talosctl) Render(ctx context.Context, n Node) ([]byte, error) {
	in, ok := t.Inputs[n.Class]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrNoClass, n.Class)
	}
	if n.Name == "" || !diskPattern.MatchString(n.Disk) {
		return nil, fmt.Errorf("node %q has no usable name or install disk %q", n.Name, n.Disk)
	}
	if a, err := netip.ParseAddr(n.Address); in.NodeNetwork != nil && (err != nil || !a.Is4()) {
		return nil, fmt.Errorf("node %q has no IPv4 address for its static network: %q", n.Name, n.Address)
	}
	patches := append([]string{}, in.ConfigPatches...)
	patches = append(patches, nodeDocument(in, n))
	if n.TPM == "2.0" {
		patches = append(patches, in.TPMPatches...)
	}
	patches = append(patches, in.ClassPatches...)

	bundle := t.decoy
	if in.MachineType == "controlplane" {
		if t.BundlePath == "" {
			return nil, ErrNoBundle
		}
		b, err := os.ReadFile(t.BundlePath)
		if err != nil {
			return nil, fmt.Errorf("read the secrets bundle: %w", err)
		}
		bundle = b
	} else if bundle == nil {
		return nil, errors.New("the renderer was not initialised")
	}

	out, err := t.genWith(ctx, bundle, in.MachineType, in.ClusterName, in.ClusterEndpoint, in.TalosContract, in.KubernetesVersion, patches)
	if err != nil {
		return nil, err
	}
	if in.MachineType == "controlplane" {
		return out, nil
	}
	real, err := t.Worker.values()
	if err != nil {
		return nil, fmt.Errorf("the worker secrets: %w", err)
	}
	return substitute(out, t.decoyValues, real)
}

// gen renders with a bundle file; genWith with the bundle's bytes.
func (t *Talosctl) gen(ctx context.Context, bundlePath, machineType, cluster, endpoint, contract, kubernetes string, patches []string) ([]byte, error) {
	bundle, err := os.ReadFile(bundlePath)
	if err != nil {
		return nil, fmt.Errorf("read the secrets bundle: %w", err)
	}
	return t.genWith(ctx, bundle, machineType, cluster, endpoint, contract, kubernetes, patches)
}

func (t *Talosctl) genWith(ctx context.Context, bundle []byte, machineType, cluster, endpoint, contract, kubernetes string, patches []string) ([]byte, error) {
	dir, err := os.MkdirTemp("", "fleet-render-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	// --config-patch would patch both machine types; the provider patches one.
	flag := "--config-patch-worker"
	if machineType == "controlplane" {
		flag = "--config-patch-control-plane"
	}
	args := []string{
		"gen", "config", cluster, endpoint,
		"--with-secrets", "/dev/stdin",
		"--talos-version", contract,
		"--kubernetes-version", kubernetes,
		"--with-docs=false", "--with-examples=false",
		"-t", machineType, "-o", "-",
	}
	for i, p := range patches {
		f := filepath.Join(dir, fmt.Sprintf("p%03d.yaml", i))
		if err := os.WriteFile(f, []byte(p), 0o600); err != nil {
			return nil, err
		}
		args = append(args, flag, "@"+f)
	}
	out, err := t.run(ctx, bundle, args...)
	if err != nil {
		return nil, fmt.Errorf("talosctl gen config: %w", err)
	}
	return out, nil
}

func (t *Talosctl) run(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	timeout := t.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, t.Bin, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("%w: %s", err, lastLine(stderr.String()))
	}
	if stdout.Len() == 0 {
		return nil, errors.New("talosctl printed nothing")
	}
	return stdout.Bytes(), nil
}

// substitute swaps every throwaway value in a rendered worker config for the
// real one. Each must occur, and none may remain, or the config is refused:
// a config with a throwaway token would never join the cluster, and one with
// a leftover would be a quiet failure.
func substitute(cfg []byte, decoy, real map[string]string) ([]byte, error) {
	out := string(cfg)
	for name, d := range decoy {
		r := real[name]
		if strings.Contains(name, "PEM") {
			var err error
			out, err = replacePEM(out, d, r)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
			continue
		}
		if !strings.Contains(out, d) {
			return nil, fmt.Errorf("%s: the render does not carry the throwaway value", name)
		}
		out = strings.ReplaceAll(out, d, r)
	}
	for name, d := range decoy {
		for _, line := range strings.Split(d, "\n") {
			if line = strings.TrimSpace(line); line != "" && strings.Contains(out, line) && !strings.Contains(real[name], line) {
				return nil, fmt.Errorf("%s: a throwaway value remains after substitution", name)
			}
		}
	}
	return []byte(out), nil
}

// replacePEM swaps an indented PEM block, as a YAML block scalar prints it,
// line for line with another, keeping the indentation it finds.
func replacePEM(out, decoy, real string) (string, error) {
	dl := strings.Split(strings.TrimSpace(decoy), "\n")
	rl := strings.Split(strings.TrimSpace(real), "\n")
	lines := strings.Split(out, "\n")
	for i := 0; i+len(dl) <= len(lines); i++ {
		indent, ok := strings.CutSuffix(lines[i], dl[0])
		if !ok || strings.TrimSpace(indent) != "" {
			continue
		}
		match := true
		for j := 1; j < len(dl); j++ {
			if lines[i+j] != indent+dl[j] {
				match = false
				break
			}
		}
		if !match {
			continue
		}
		replaced := make([]string, 0, len(rl))
		for _, l := range rl {
			replaced = append(replaced, indent+l)
		}
		lines = append(lines[:i], append(replaced, lines[i+len(dl):]...)...)
		return strings.Join(lines, "\n"), nil
	}
	return "", errors.New("the render does not carry the throwaway certificate")
}

// nodeDocument is the node's own patch: the documents the Talos root's
// talos-cluster module renders per node, from the node's facts.
func nodeDocument(in ClassInputs, n Node) string {
	labels := map[string]any{"bgp-enabled": "true"}
	for k, v := range in.Labels {
		labels[k] = v
	}
	if n.TPM == "2.0" {
		for k, v := range in.TPMLabels {
			labels[k] = v
		}
	}
	kubeNode := map[string]any{
		"apiVersion": "v1alpha1",
		"kind":       "KubeNodeConfig",
		"labels":     labels,
	}
	if in.MachineType == "controlplane" {
		labels["node.kubernetes.io/exclude-from-external-load-balancers"] = map[string]any{"$patch": "delete"}
		kubeNode["taints"] = map[string]any{"node-role.kubernetes.io/control-plane": map[string]any{"$patch": "delete"}}
	}
	docs := []any{
		map[string]any{"apiVersion": "v1alpha1", "kind": "HostnameConfig", "auto": "off", "hostname": n.Name},
		map[string]any{
			"apiVersion": "v1alpha1",
			"kind":       "UnattendedInstallConfig",
			"installer":  map[string]any{"image": in.InstallerImage},
			"provisioning": map[string]any{
				"diskSelector": map[string]any{"match": fmt.Sprintf("disk.dev_path == %q", n.Disk)},
				"wipe":         true,
			},
		},
		map[string]any{"machine": map[string]any{"certSANs": []string{n.Name + "." + in.DNSZone}}},
		kubeNode,
	}
	if nn := in.NodeNetwork; nn != nil {
		docs = append(docs, map[string]any{
			"apiVersion": "v1alpha1",
			"kind":       "LinkConfig",
			"name":       nn.Link,
			"up":         true,
			"addresses":  []any{map[string]any{"address": fmt.Sprintf("%s/%d", n.Address, nn.PrefixLength)}},
			"routes":     []any{map[string]any{"gateway": nn.Gateway}},
		})
	}
	parts := make([]string, 0, len(docs))
	for _, d := range docs {
		b, _ := yaml.Marshal(d)
		parts = append(parts, string(b))
	}
	return strings.Join(parts, "---\n")
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}
