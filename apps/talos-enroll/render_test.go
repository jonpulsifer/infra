package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadClassInputsRefusesAnIncompleteClass(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "in.json")
	_ = os.WriteFile(f, []byte(`{"worker-g5":{"machine_type":"worker","cluster_name":"c"}}`), 0o600)
	if _, err := LoadClassInputs(f); err == nil {
		t.Fatal("an incomplete class loaded")
	}
	_ = os.WriteFile(f, []byte(`{}`), 0o600)
	if in, err := LoadClassInputs(f); err != nil || len(in) != 0 {
		t.Fatalf("an empty file: %v %v", in, err)
	}
}

const fakePEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\nline2\n-----END CERTIFICATE-----"

func fakeBundle(prefix string) string {
	return "cluster:\n  id: " + prefix + "id\n  secret: " + prefix + "secret\n" +
		"secrets:\n  bootstraptoken: " + prefix + "boot\n  secretboxencryptionsecret: x\n" +
		"trustdinfo:\n  token: " + prefix + "trustd\n" +
		"certs:\n  k8s:\n    crt: " + base64.StdEncoding.EncodeToString([]byte(strings.ReplaceAll(fakePEM, "fake", prefix))) + "\n    key: k\n" +
		"  os:\n    crt: " + prefix + "oscrt\n    key: k\n"
}

func TestWorkerSecretsParseTheBundleShape(t *testing.T) {
	w, err := parseWorkerSecrets([]byte(fakeBundle("A")))
	if err != nil {
		t.Fatal(err)
	}
	v, _ := w.values()
	if v["trustdinfo.token"] != "Atrustd" || !strings.Contains(v["certs.k8s.crt (PEM)"], "MIIBA") {
		t.Fatalf("values: %v", v)
	}
	if _, err := parseWorkerSecrets([]byte("cluster:\n  id: x\n")); err == nil {
		t.Fatal("a bundle with no tokens parsed")
	}
}

func TestSubstituteSwapsEveryValueAndRefusesALeftover(t *testing.T) {
	decoy, _ := parseWorkerSecrets([]byte(fakeBundle("D")))
	real, _ := parseWorkerSecrets([]byte(fakeBundle("R")))
	dv, _ := decoy.values()
	rv, _ := real.values()
	cfg := "machine:\n    token: Dtrustd\n    ca:\n        crt: Doscrt\ncluster:\n    token: Dboot\n---\nclusterID: Did\nclusterSecret: Dsecret\n---\nacceptedCAs:\n    - |\n      -----BEGIN CERTIFICATE-----\n      MIIBD\n      line2\n      -----END CERTIFICATE-----\n"
	out, err := substitute([]byte(cfg), dv, rv)
	if err != nil {
		t.Fatal(err)
	}
	want := strings.NewReplacer("Dtrustd", "Rtrustd", "Doscrt", "Roscrt", "Dboot", "Rboot", "Did", "Rid", "Dsecret", "Rsecret", "MIIBD", "MIIBR").Replace(cfg)
	if string(out) != want {
		t.Fatalf("substituted:\n%s\nwant:\n%s", out, want)
	}
	if _, err := substitute([]byte(strings.Replace(cfg, "Dboot", "other", 1)), dv, rv); err == nil {
		t.Fatal("a render without the throwaway token passed")
	}
	if _, err := substitute([]byte(cfg+"\nextra: Dsecret\n"), dv, map[string]string{"cluster.id": "Rid", "cluster.secret": "Dsecret", "secrets.bootstraptoken": "Rboot", "trustdinfo.token": "Rtrustd", "certs.os.crt": "Roscrt", "certs.k8s.crt (PEM)": rv["certs.k8s.crt (PEM)"]}); err != nil {
		t.Fatalf("a real value that equals the throwaway one is no leftover: %v", err)
	}
}

func TestNodeDocument(t *testing.T) {
	in := ClassInputs{MachineType: "worker", InstallerImage: "ghcr.io/x/installer:v1", DNSZone: "example.test",
		Labels: map[string]string{"class": "g5"}, TPMLabels: map[string]string{"example.test/tpm": "true"}}
	doc := nodeDocument(in, Node{Name: "swell", Disk: "/dev/nvme0n1", TPM: "2.0"})
	for _, want := range []string{"hostname: swell", `match: disk.dev_path == "/dev/nvme0n1"`, "image: ghcr.io/x/installer:v1", "- swell.example.test", "example.test/tpm", "class: g5", "bgp-enabled"} {
		if !strings.Contains(doc, want) {
			t.Errorf("the node document lacks %q:\n%s", want, doc)
		}
	}
	if strings.Contains(doc, "$patch") {
		t.Error("a worker document carries a control-plane deletion")
	}
	plain := nodeDocument(in, Node{Name: "shale", Disk: "/dev/sda", TPM: "1.2"})
	if strings.Contains(plain, "example.test/tpm") {
		t.Error("a TPM 1.2 node got the TPM label")
	}
	in.MachineType = "controlplane"
	cp := nodeDocument(in, Node{Name: "optiplex", Disk: "/dev/sda", TPM: "2.0"})
	if !strings.Contains(cp, "node-role.kubernetes.io/control-plane") || !strings.Contains(cp, "exclude-from-external-load-balancers") {
		t.Errorf("the control-plane document lacks its deletions:\n%s", cp)
	}
}

func TestLoadInventory(t *testing.T) {
	f := filepath.Join(t.TempDir(), "machines.yaml")
	_ = os.WriteFile(f, []byte("machines:\n  riptide:\n    serial: MXL1\n    mac: 38:22:E2:2D:96:44\n    class: worker-g5\n    status: active\n    address: 10.3.0.12\n    disk: /dev/nvme0n1\n    tpm: \"2.0\"\n  intake:\n    serial: NEW1\n    mac: aa:bb:cc:dd:ee:ff\n    disk: /dev/sda\n"), 0o600)
	inv, err := LoadInventory(f)
	if err != nil {
		t.Fatal(err)
	}
	n, err := inv.BySerial(context.Background(), "mxl1")
	if err != nil || n.Name != "riptide" || n.MAC != "38:22:e2:2d:96:44" || n.Class != "worker-g5" || n.Source != "inventory" {
		t.Fatalf("by serial: %+v %v", n, err)
	}
	if names, _ := inv.Names(context.Background()); len(names) != 1 || names[0] != "riptide" {
		t.Fatalf("a machine with no class is not a node to enroll as: %v", names)
	}
	if _, err := inv.ByName(context.Background(), "nope"); !errors.Is(err, ErrUnknownNode) {
		t.Fatalf("unknown name: %v", err)
	}
	if empty, err := LoadInventory(""); err != nil || len(empty.byName) != 0 {
		t.Fatalf("no path is an empty inventory: %v", err)
	}
}

// TestTalosctlRender runs the real binary with a throwaway bundle. CI has no
// talosctl, so it runs where mise installed one. It proves that a worker
// rendered from the throwaway bundle and the worker secrets is byte for byte
// the render from the full bundle.
func TestTalosctlRender(t *testing.T) {
	bin, err := exec.LookPath("talosctl")
	if err != nil {
		t.Skip("talosctl is not on PATH")
	}
	dir := t.TempDir()
	bundle := filepath.Join(dir, "secrets.yaml")
	if out, err := exec.Command(bin, "gen", "secrets", "-o", bundle).CombinedOutput(); err != nil {
		t.Fatalf("gen secrets: %v %s", err, out)
	}
	worker, err := LoadWorkerSecrets(bundle)
	if err != nil {
		t.Fatal(err)
	}
	inputs := map[string]ClassInputs{
		"worker-g5": {
			MachineType: "worker", ClusterName: "folly", ClusterEndpoint: "https://cluster.example:6443",
			TalosContract: "v1.14", KubernetesVersion: "v1.36.3", InstallerImage: "ghcr.io/x/installer:v1", DNSZone: "example.test",
			ConfigPatches: []string{"apiVersion: v1alpha1\nkind: SysctlConfig\nparams:\n  vm.max_map_count: \"1048576\"\n"},
			TPMPatches:    []string{"apiVersion: v1alpha1\nkind: SysctlConfig\nparams:\n  kernel.kexec_load_disabled: \"1\"\n"},
			ClassPatches:  []string{"apiVersion: v1alpha1\nkind: VolumeConfig\nname: EPHEMERAL\nprovisioning:\n  maxSize: 80GiB\n"},
			TPMLabels:     map[string]string{"example.test/tpm": "true"},
		},
		"controlplane": {
			MachineType: "controlplane", ClusterName: "folly", ClusterEndpoint: "https://cluster.example:6443",
			TalosContract: "v1.14", KubernetesVersion: "v1.36.3", InstallerImage: "ghcr.io/x/installer:v1", DNSZone: "example.test",
		},
	}
	node := Node{Name: "riptide", Class: "worker-g5", Disk: "/dev/nvme0n1", TPM: "2.0"}
	ctx := context.Background()

	withDecoy := &Talosctl{Bin: bin, Worker: worker, Inputs: inputs}
	if err := withDecoy.Init(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := withDecoy.Render(ctx, node)
	if err != nil {
		t.Fatal(err)
	}
	// The same renderer with the real bundle as its throwaway: the
	// substitution is then the identity, so this is the plain render.
	plain := &Talosctl{Bin: bin, Worker: worker, Inputs: inputs}
	plain.decoy, _ = os.ReadFile(bundle)
	plain.decoyValues, _ = worker.values()
	want, err := plain.Render(ctx, node)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("the throwaway render differs from the full-bundle render:\n%s\n---\n%s", got, want)
	}
	for _, s := range []string{"type: worker", "hostname: riptide", `disk.dev_path == "/dev/nvme0n1"`, "example.test/tpm", "kexec_load_disabled", "maxSize: 80GiB", "kubelet:v1.36.3"} {
		if !strings.Contains(string(got), s) {
			t.Errorf("the render lacks %q", s)
		}
	}
	if strings.Contains(string(got), "# ") {
		t.Error("the render carries comments, which the provider leaves out")
	}

	cp := Node{Name: "optiplex", Class: "controlplane", Disk: "/dev/sda", TPM: "2.0"}
	if _, err := withDecoy.Render(ctx, cp); !errors.Is(err, ErrNoBundle) {
		t.Fatalf("a control plane without the bundle: %v", err)
	}
	withDecoy.BundlePath = bundle
	out, err := withDecoy.Render(ctx, cp)
	if err != nil || !strings.Contains(string(out), "type: controlplane") {
		t.Fatalf("a control plane with the bundle: %v", err)
	}
	if _, err := withDecoy.Render(ctx, Node{Name: "x", Class: "worker-g2", Disk: "/dev/sda"}); !errors.Is(err, ErrNoClass) {
		t.Fatalf("an unknown class: %v", err)
	}
	if _, err := withDecoy.Render(ctx, Node{Name: "x", Class: "worker-g5", Disk: "sda; rm"}); err == nil {
		t.Fatal("a bad disk rendered")
	}
}

// TestRenderParity is the guard between this server's render of a node (its
// class inputs plus the node document it writes) and the talos-cluster
// module's install render of the same node. .github/scripts/talos-render-
// parity.sh evaluates the root and runs it with:
//
//	ENROLL_PARITY_INPUTS  the module's install_inputs, per node
//	ENROLL_PARITY_NODES   per node: class, disk, tpm, from the inventory
//	ENROLL_CLASS_INPUTS   the committed class-inputs.json
//	ENROLL_PARITY_BUNDLE  a throwaway talosctl gen secrets bundle
//
// A worker goes through the throwaway-bundle path with the bundle's worker
// subset; a control plane through the bundle.
func TestRenderParity(t *testing.T) {
	inputsPath, nodesPath, classPath, bundle := os.Getenv("ENROLL_PARITY_INPUTS"), os.Getenv("ENROLL_PARITY_NODES"), os.Getenv("ENROLL_CLASS_INPUTS"), os.Getenv("ENROLL_PARITY_BUNDLE")
	if inputsPath == "" || nodesPath == "" || classPath == "" || bundle == "" {
		t.Skip("ENROLL_PARITY_* is not set; the parity script sets it")
	}
	bin, err := exec.LookPath("talosctl")
	if err != nil {
		t.Fatal("the parity check needs talosctl")
	}
	var moduleInputs map[string]struct {
		MachineType       string   `json:"machine_type"`
		ClusterName       string   `json:"cluster_name"`
		ClusterEndpoint   string   `json:"cluster_endpoint"`
		TalosContract     string   `json:"talos_contract"`
		KubernetesVersion string   `json:"kubernetes_version"`
		ConfigPatches     []string `json:"config_patches"`
	}
	var facts map[string]struct {
		Class string `json:"class"`
		Disk  string `json:"disk"`
		TPM   string `json:"tpm"`
	}
	for path, into := range map[string]any{inputsPath: &moduleInputs, nodesPath: &facts} {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(raw, into); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
	}
	classes, err := LoadClassInputs(classPath)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := LoadWorkerSecrets(bundle)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	server := &Talosctl{Bin: bin, BundlePath: bundle, Worker: worker, Inputs: classes}
	if err := server.Init(ctx); err != nil {
		t.Fatal(err)
	}
	module := &Talosctl{Bin: bin}
	if len(moduleInputs) == 0 {
		t.Fatal("no node to compare")
	}
	for name, in := range moduleInputs {
		fact, ok := facts[name]
		if !ok {
			t.Errorf("%s: the inventory has no facts for it", name)
			continue
		}
		got, err := server.Render(ctx, Node{Name: name, Class: fact.Class, Disk: fact.Disk, TPM: fact.TPM})
		if err != nil {
			t.Errorf("%s: the server's render: %v", name, err)
			continue
		}
		want, err := module.gen(ctx, bundle, in.MachineType, in.ClusterName, in.ClusterEndpoint, in.TalosContract, in.KubernetesVersion, in.ConfigPatches)
		if err != nil {
			t.Errorf("%s: the module's render: %v", name, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: the server's render differs from the module's:\n--- server\n%s\n--- module\n%s", name, got, want)
			continue
		}
		t.Logf("ok %s: %d bytes, class %s", name, len(got), fact.Class)
	}
}
