package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// MachineInputs is one node's entry in the Talos root's machine_inputs output.
// config_patches are in the order the root applies them.
type MachineInputs struct {
	MachineType       string   `json:"machine_type"`
	ClusterName       string   `json:"cluster_name"`
	ClusterEndpoint   string   `json:"cluster_endpoint"`
	TalosContract     string   `json:"talos_contract"`
	KubernetesVersion string   `json:"kubernetes_version"`
	ConfigPatches     []string `json:"config_patches"`
}

func (m MachineInputs) validate() error {
	if m.MachineType != "controlplane" && m.MachineType != "worker" {
		return fmt.Errorf("machine_type %q is neither controlplane nor worker", m.MachineType)
	}
	for name, v := range map[string]string{
		"cluster_name": m.ClusterName, "cluster_endpoint": m.ClusterEndpoint,
		"talos_contract": m.TalosContract, "kubernetes_version": m.KubernetesVersion,
	} {
		if v == "" {
			return fmt.Errorf("%s is empty", name)
		}
	}
	return nil
}

// LoadMachineInputs reads the file that `mise run render-machine-inputs`
// writes. A node whose inputs do not validate is refused at load.
func LoadMachineInputs(path string) (map[string]MachineInputs, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var inputs map[string]MachineInputs
	if err := json.Unmarshal(raw, &inputs); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for node, in := range inputs {
		if err := in.validate(); err != nil {
			return nil, fmt.Errorf("%s: node %s: %w", path, node, err)
		}
	}
	return inputs, nil
}

// LoadNodeMACs reads the optional node-to-MAC hints. A missing file is no hints.
func LoadNodeMACs(path string) (map[string]string, error) {
	if path == "" {
		return map[string]string{}, nil
	}
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]string{}, nil
	}
	if err != nil {
		return nil, err
	}
	var macs map[string]string
	if err := json.Unmarshal(raw, &macs); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	for node, mac := range macs {
		macs[node] = strings.ToLower(mac)
	}
	return macs, nil
}

// Renderer turns a node name into its machine config.
type Renderer interface {
	Nodes() []string
	Render(ctx context.Context, node string) ([]byte, error)
}

// Talosctl renders with `talosctl gen config --with-secrets`, the recipe that
// matches the Talos provider byte for byte.
type Talosctl struct {
	Bin        string
	BundlePath string
	Inputs     map[string]MachineInputs
	Timeout    time.Duration
}

func (t *Talosctl) Nodes() []string {
	nodes := make([]string, 0, len(t.Inputs))
	for n := range t.Inputs {
		nodes = append(nodes, n)
	}
	sort.Strings(nodes)
	return nodes
}

func (t *Talosctl) Render(ctx context.Context, node string) ([]byte, error) {
	in, ok := t.Inputs[node]
	if !ok {
		return nil, ErrUnknownNode
	}
	bundle, err := os.ReadFile(t.BundlePath)
	if err != nil {
		return nil, fmt.Errorf("read the secrets bundle: %w", err)
	}
	dir, err := os.MkdirTemp("", "talos-enroll-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)

	// --config-patch would patch both machine types; the provider patches one.
	flag := "--config-patch-worker"
	if in.MachineType == "controlplane" {
		flag = "--config-patch-control-plane"
	}
	args := []string{
		"gen", "config", in.ClusterName, in.ClusterEndpoint,
		"--with-secrets", "/dev/stdin",
		"--talos-version", in.TalosContract,
		"--kubernetes-version", in.KubernetesVersion,
		"--with-docs=false", "--with-examples=false",
		"-t", in.MachineType, "-o", "-",
	}
	for i, p := range in.ConfigPatches {
		f := filepath.Join(dir, fmt.Sprintf("p%03d.yaml", i))
		if err := os.WriteFile(f, []byte(p), 0o600); err != nil {
			return nil, err
		}
		args = append(args, flag, "@"+f)
	}

	timeout := t.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, t.Bin, args...)
	cmd.Stdin = bytes.NewReader(bundle)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("talosctl gen config: %w: %s", err, lastLine(stderr.String()))
	}
	if stdout.Len() == 0 {
		return nil, fmt.Errorf("talosctl gen config printed no config")
	}
	return stdout.Bytes(), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return lines[len(lines)-1]
}
