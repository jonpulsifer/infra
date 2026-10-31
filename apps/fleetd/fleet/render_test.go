package fleet

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
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

func TestNodeDocumentStaticAddress(t *testing.T) {
	in := riptideInputs()["worker-g5"]
	if strings.Contains(nodeDocument(in, riptide), "LinkConfig") {
		t.Fatal("a class without node_network got a LinkConfig")
	}
	in.NodeNetwork = &NodeNetwork{Link: "net0", PrefixLength: 26, Gateway: "192.0.2.1"}
	n := riptide
	n.Address = "192.0.2.12"
	doc := nodeDocument(in, n)
	for _, want := range []string{"kind: LinkConfig", "name: net0", "up: true", "- address: 192.0.2.12/26", "- gateway: 192.0.2.1"} {
		if !strings.Contains(doc, want) {
			t.Errorf("the node document lacks %q:\n%s", want, doc)
		}
	}
	r := &Talosctl{Inputs: map[string]ClassInputs{"worker-g5": in}, decoy: []byte("x")}
	for _, addr := range []string{"", "2001:db8::1", "not-an-address"} {
		n.Address = addr
		if _, err := r.Render(context.Background(), n); err == nil || !strings.Contains(err.Error(), "static network") {
			t.Errorf("a render with address %q was not refused: %v", addr, err)
		}
	}
}

func TestClassInputsRefuseABadNodeNetwork(t *testing.T) {
	base := riptideInputs()["worker-g5"]
	for _, nn := range []NodeNetwork{{PrefixLength: 26, Gateway: "192.0.2.1"}, {Link: "net0", Gateway: "192.0.2.1"}, {Link: "net0", PrefixLength: 26, Gateway: "2001:db8::1"}} {
		in := base
		in.NodeNetwork = &nn
		if err := in.validate(); err == nil {
			t.Errorf("node_network %+v validated", nn)
		}
	}
	base.NodeNetwork = &NodeNetwork{Link: "net0", PrefixLength: 26, Gateway: "192.0.2.1"}
	if err := base.validate(); err != nil {
		t.Fatal(err)
	}
}

// TestNodeDocumentGolden holds the node document for riptide, from the
// fixture TestTalosctlRender uses, to testdata/riptide-node-document.yaml. A
// change to it changes every worker's first config, which the parity check
// against the Talos root also sees.
func TestNodeDocumentGolden(t *testing.T) {
	want, err := os.ReadFile("testdata/riptide-node-document.yaml")
	if err != nil {
		t.Fatal(err)
	}
	in := riptideInputs()["worker-g5"]
	got := nodeDocument(in, riptide)
	if got != string(want) {
		t.Fatalf("the node document differs from the golden file:\n%s\n--- golden\n%s", got, want)
	}
}

var riptide = Node{Name: "riptide", Class: "worker-g5", Disk: "/dev/nvme0n1", TPM: "2.0"}

// riptideInputs is TestTalosctlRender's fixture.
func riptideInputs() map[string]ClassInputs {
	return map[string]ClassInputs{
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
	inputs := riptideInputs()
	node := riptide
	ctx := context.Background()

	withDecoy := &Talosctl{Bin: bin, Worker: worker, Inputs: inputs}
	if err := withDecoy.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := withDecoy.Render(ctx, node); err == nil || !strings.Contains(err.Error(), "bootstrap token") {
		t.Fatalf("a worker without its own token rendered: %v", err)
	}
	// With the bundle's own token as the node's, the throwaway render must
	// be the plain one: the same renderer with the real bundle as its
	// throwaway, whose substitution is the identity.
	node.BootstrapToken = worker.Secrets.BootstrapToken
	got, err := withDecoy.Render(ctx, node)
	if err != nil {
		t.Fatal(err)
	}
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
	// The node's own token replaces the cluster's at cluster.token, and is
	// the only difference.
	own := JoinTokenID(node.Name) + ".0123456789abcdef"
	node.BootstrapToken = own
	mine, err := withDecoy.Render(ctx, node)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(mine, []byte(worker.Secrets.BootstrapToken)) || !bytes.Contains(mine, []byte("    token: "+own+"\n")) {
		t.Fatalf("the node's token is not the config's cluster.token:\n%s", mine)
	}
	if !bytes.Equal(bytes.ReplaceAll(mine, []byte(own), []byte(worker.Secrets.BootstrapToken)), want) {
		t.Fatal("the node's token changed more than cluster.token")
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
	// A control plane carries the bundle's CA keys and nothing of the
	// throwaway bundle, which only workers are rendered from.
	raw, _ := os.ReadFile(bundle)
	var keys struct {
		Certs map[string]struct {
			Key string `yaml:"key"`
		} `yaml:"certs"`
	}
	if err := yaml.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	// Talos prints a key as the bundle's base64, or as the PEM in a document.
	for _, ca := range []string{"os", "etcd", "k8s", "k8saggregator", "k8sserviceaccount"} {
		k := keys.Certs[ca].Key
		pem, _ := base64.StdEncoding.DecodeString(k)
		body := strings.Split(string(pem), "\n")
		if k == "" || len(body) < 2 || !strings.Contains(string(out), k) && !strings.Contains(string(out), body[1]) {
			t.Errorf("the control plane lacks the bundle's %s key", ca)
		}
	}
	for name, v := range withDecoy.decoyValues {
		if first := strings.SplitN(v, "\n", 2)[0]; !strings.Contains(name, "PEM") && strings.Contains(string(out), first) {
			t.Errorf("the control plane carries the throwaway %s", name)
		}
	}
	if _, err := withDecoy.Render(ctx, Node{Name: "x", Class: "worker-g2", Disk: "/dev/sda"}); !errors.Is(err, ErrNoClass) {
		t.Fatalf("an unknown class: %v", err)
	}
	if _, err := withDecoy.Render(ctx, Node{Name: "x", Class: "worker-g5", Disk: "sda; rm", BootstrapToken: own}); err == nil {
		t.Fatal("a bad disk rendered")
	}
}

// TestRenderParity is the guard between fleetd's render of a node
// (its class inputs plus the node document it writes) and the talos-cluster
// module's install render of the same node. .github/scripts/talos-render-
// parity.sh evaluates the root and runs it with:
//
//	FLEET_PARITY_INPUTS  the module's install_inputs, per node
//	FLEET_PARITY_NODES   per node: class, disk, tpm, from the inventory
//	FLEET_CLASS_INPUTS   the committed class-inputs.json
//	FLEET_PARITY_BUNDLE  a throwaway talosctl gen secrets bundle
//
// A worker goes through the throwaway-bundle path with the bundle's worker
// subset; a control plane through the bundle. The script adds joining-cp, an
// active control plane that joins the cluster, so a second control plane is
// always compared.
func TestRenderParity(t *testing.T) {
	inputsPath, nodesPath, classPath, bundle := os.Getenv("FLEET_PARITY_INPUTS"), os.Getenv("FLEET_PARITY_NODES"), os.Getenv("FLEET_CLASS_INPUTS"), os.Getenv("FLEET_PARITY_BUNDLE")
	if inputsPath == "" || nodesPath == "" || classPath == "" || bundle == "" {
		t.Skip("FLEET_PARITY_* is not set; the parity script sets it")
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
		Class   string `json:"class"`
		Disk    string `json:"disk"`
		TPM     string `json:"tpm"`
		Address string `json:"address"`
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
	controller := &Talosctl{Bin: bin, BundlePath: bundle, Worker: worker, Inputs: classes}
	if err := controller.Init(ctx); err != nil {
		t.Fatal(err)
	}
	module := &Talosctl{Bin: bin}
	if len(moduleInputs) == 0 {
		t.Fatal("no node to compare")
	}
	controlPlanes := 0
	for name, in := range moduleInputs {
		fact, ok := facts[name]
		if !ok {
			t.Errorf("%s: the inventory has no facts for it", name)
			continue
		}
		var token string
		if in.MachineType == "worker" {
			token = JoinTokenID(name) + ".0123456789abcdef"
		}
		got, err := controller.Render(ctx, Node{Name: name, Class: fact.Class, Disk: fact.Disk, TPM: fact.TPM, Address: fact.Address, BootstrapToken: token})
		if err != nil {
			t.Errorf("%s: fleetd's render: %v", name, err)
			continue
		}
		want, err := module.gen(ctx, bundle, in.MachineType, in.ClusterName, in.ClusterEndpoint, in.TalosContract, in.KubernetesVersion, in.ConfigPatches)
		if err != nil {
			t.Errorf("%s: the module's render: %v", name, err)
			continue
		}
		// A worker's config carries the bootstrap token fleetd made for its
		// install where the module's carries the cluster's. That one value
		// differs by design, once, at cluster.token; every other byte must
		// match.
		if token != "" {
			if n := bytes.Count(got, []byte(token)); n != 1 || !bytes.Contains(got, []byte("    token: "+token+"\n")) {
				t.Errorf("%s: fleetd's render carries its own token %d times, or not as cluster.token", name, n)
				continue
			}
			got = bytes.ReplaceAll(got, []byte(token), []byte(worker.Secrets.BootstrapToken))
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: fleetd's render differs from the module's:\n--- controller\n%s\n--- module\n%s", name, got, want)
			continue
		}
		if nn := classes[fact.Class].NodeNetwork; nn != nil && !bytes.Contains(got, []byte(fmt.Sprintf("- address: %s/%d\n", fact.Address, nn.PrefixLength))) {
			t.Errorf("%s: both renders lack its static address %s", name, fact.Address)
		}
		if in.MachineType == "controlplane" {
			controlPlanes++
		}
		t.Logf("ok %s: %d bytes, class %s", name, len(got), fact.Class)
	}
	if _, ok := moduleInputs["joining-cp"]; !ok || controlPlanes < 2 {
		t.Errorf("compared %d control planes; the parity needs the root's and joining-cp", controlPlanes)
	}
}

func fullFakeBundle(prefix string) string {
	return fakeBundle(prefix) + "  etcd:\n    crt: c\n    key: k\n  k8saggregator:\n    crt: c\n    key: k\n  k8sserviceaccount:\n    key: k\n"
}

func TestLoadBundleNeedsTheFullBundleOfTheWorkersCluster(t *testing.T) {
	worker, _ := parseWorkerSecrets([]byte(fakeBundle("A")))
	dir := t.TempDir()
	for name, c := range map[string]struct {
		bundle string
		ok     bool
	}{
		"the full bundle":            {fullFakeBundle("A"), true},
		"the worker subset":          {fakeBundle("A"), false},
		"a bundle without secretbox": {strings.Replace(fullFakeBundle("A"), "secretboxencryptionsecret: x", `secretboxencryptionsecret: ""`, 1), false},
		"another cluster's bundle":   {fullFakeBundle("B"), false},
	} {
		f := filepath.Join(dir, strings.ReplaceAll(name, " ", "-"))
		_ = os.WriteFile(f, []byte(c.bundle), 0o600)
		if err := LoadBundle(f, worker); (err == nil) != c.ok {
			t.Errorf("%s: %v", name, err)
		}
	}
}
