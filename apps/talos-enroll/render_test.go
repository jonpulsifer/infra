package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadMachineInputsRefusesAnIncompleteNode(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "in.json")
	_ = os.WriteFile(f, []byte(`{"riptide":{"machine_type":"worker","cluster_name":"c"}}`), 0o600)
	if _, err := LoadMachineInputs(f); err == nil {
		t.Fatal("an incomplete node loaded")
	}
	_ = os.WriteFile(f, []byte(`{}`), 0o600)
	if in, err := LoadMachineInputs(f); err != nil || len(in) != 0 {
		t.Fatalf("an empty file: %v %v", in, err)
	}
}

// TestTalosctlRender runs the real binary with a throwaway bundle. CI has no
// talosctl, so it runs where mise installed one.
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
	in := MachineInputs{
		MachineType:       "worker",
		ClusterName:       "folly",
		ClusterEndpoint:   "https://cluster.example:6443",
		TalosContract:     "v1.14",
		KubernetesVersion: "v1.36.3",
		ConfigPatches: []string{
			"apiVersion: v1alpha1\nkind: SysctlConfig\nparams:\n  vm.max_map_count: \"1048576\"\n",
			"machine:\n  nodeLabels:\n    lolwtf.ca/test: \"yes\"\n",
		},
	}
	r := &Talosctl{Bin: bin, BundlePath: bundle, Inputs: map[string]MachineInputs{"riptide": in}}
	a, err := r.Render(context.Background(), "riptide")
	if err != nil {
		t.Fatal(err)
	}
	b, err := r.Render(context.Background(), "riptide")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("two renders differ")
	}
	for _, want := range []string{"type: worker", "lolwtf.ca/test", "kind: SysctlConfig", "kubelet:v1.36.3"} {
		if !strings.Contains(string(a), want) {
			t.Errorf("the render lacks %q", want)
		}
	}
	if strings.Contains(string(a), "# ") {
		t.Error("the render carries comments, which the provider leaves out")
	}
	if _, err := r.Render(context.Background(), "shale"); err != ErrUnknownNode {
		t.Fatalf("an unknown node: %v", err)
	}
}
