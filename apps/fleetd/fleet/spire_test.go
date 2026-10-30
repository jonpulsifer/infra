package fleet

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var (
	hashA = strings.Repeat("a", 64)
	hashB = strings.Repeat("b", 64)
)

func spireDevice(name, status, verdict string, cf map[string]any) map[string]any {
	d := device(name, status, "none", map[string]any{"attest_verdict": verdict})
	for k, v := range cf {
		d["custom_fields"].(map[string]any)[k] = v
	}
	return d
}

func reconcileSpire(t *testing.T, path string, devices ...map[string]any) {
	t.Helper()
	nb := &fakeNetBox{devices: devices, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	r.SpireNodesFile = path
	_ = r.Reconcile(context.Background())
}

func TestSpireNodesRegisterAttestedActiveDevices(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spire-nodes.json")
	reconcileSpire(t, path, spireDevice("riptide", "active", "attested", map[string]any{"ek_hash": hashB, "ek_hash_ecc": hashA}))
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := `{
  "nodes": [
    {
      "name": "riptide",
      "ek_hashes": [
        "` + hashA + `",
        "` + hashB + `"
      ]
    }
  ]
}
`
	if string(got) != want {
		t.Errorf("file:\n%s", got)
	}
}

func TestSpireNodesWithdrawEachLeavingState(t *testing.T) {
	cases := map[string]struct{ status, verdict string }{
		"decommissioning": {"decommissioning", "attested"},
		"failed":          {"failed", "attested"},
		"planned":         {"planned", "attested"},
		"quarantined":     {"active", "quarantined: pcr"},
		"no verdict":      {"active", ""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if n := SpireNodesOf([]Device{{Name: "riptide", Status: c.status, Verdict: c.verdict}}); len(n) != 0 {
				t.Errorf("nodes %v", n)
			}
		})
	}
	path := filepath.Join(t.TempDir(), "spire-nodes.json")
	reconcileSpire(t, path, spireDevice("riptide", "active", "attested", nil), spireDevice("optiplex", "active", "attested", nil))
	reconcileSpire(t, path, spireDevice("riptide", "decommissioning", "attested", nil), spireDevice("optiplex", "active", "attested", nil))
	got, _ := os.ReadFile(path)
	if strings.Contains(string(got), "riptide") || !strings.Contains(string(got), "optiplex") {
		t.Errorf("file:\n%s", got)
	}
}

func TestSpireNodesRejectsUnsafeValuesAndIsIdempotent(t *testing.T) {
	nodes := SpireNodesOf([]Device{
		{Name: "bad name", Status: "active", Verdict: "attested"},
		{Name: "ok", Status: "active", Verdict: "attested", EKHash: "XYZ", EKHashECC: hashA},
	})
	if len(nodes) != 1 || nodes[0].Name != "ok" || len(nodes[0].EKHashes) != 1 {
		t.Fatalf("nodes %v", nodes)
	}
	path := filepath.Join(t.TempDir(), "n.json")
	if err := writeSpireNodes(path, nodes); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(path)
	if err := writeSpireNodes(path, nodes); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(path)
	if !os.SameFile(before, after) {
		t.Error("an unchanged file was replaced")
	}
}

func TestSpireNodesFileLeftAloneForEmptyNetBox(t *testing.T) {
	path := filepath.Join(t.TempDir(), "n.json")
	if err := os.WriteFile(path, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	reconcileSpire(t, path)
	if b, _ := os.ReadFile(path); string(b) != "keep" {
		t.Errorf("file %q", b)
	}
}
