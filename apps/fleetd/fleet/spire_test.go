package fleet

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

var (
	hashA = strings.Repeat("a", 64)
	hashB = strings.Repeat("b", 64)
	hashC = strings.Repeat("c", 64)
	fpA   = strings.Repeat("1", 40)
	fpB   = strings.Repeat("2", 40)
	fpC   = strings.Repeat("3", 40)
)

// A machine is revoked while its device is decommissioning, or absent from
// the live devices because it is offline or deleted; its LDevID until its
// notAfter. A held, failed or quarantined node is withdrawn, not revoked.
func TestSpireNodesRevokeRetiredMachines(t *testing.T) {
	devices := []Device{
		{Name: "riptide", Status: "active", Verdict: "attested", EKHash: hashA},
		{Name: "surge", Status: "decommissioning", Verdict: "attested", EKHash: hashB},
		{Name: "swell", Status: "failed", Verdict: "attested"},
		{Name: "tide", Status: "active", Verdict: "quarantined: pcr"},
	}
	soon, past := testNow.Add(time.Hour), testNow.Add(-time.Second)
	got := SpireNodesOf(devices, []Identity{
		{Machine: "riptide", Fingerprint: fpA, NotAfter: soon, EKHashes: []string{hashA}},
		{Machine: "surge", Fingerprint: fpB, NotAfter: soon, EKHashes: []string{hashB}},
		{Machine: "swell", Fingerprint: fpC, NotAfter: soon},
		{Machine: "tide", Fingerprint: fpC, NotAfter: soon},
		{Machine: "shale", Fingerprint: fpC, NotAfter: past, EKHashes: []string{hashC}},
		// The TPM riptide registers moved from this name, so its EK stays.
		{Machine: "riptide-old", Fingerprint: fpA, NotAfter: soon, EKHashes: []string{hashA}},
	}, testNow)
	want := []RevokedNode{
		{Name: "riptide-old", EKHashes: []string{}, LDevIDs: []string{fpA}},
		{Name: "shale", EKHashes: []string{hashC}, LDevIDs: []string{}},
		{Name: "surge", EKHashes: []string{hashB}, LDevIDs: []string{fpB}},
	}
	if !reflect.DeepEqual(got.Revoked, want) {
		t.Errorf("revoked:\n got %+v\nwant %+v", got.Revoked, want)
	}
	if len(got.Nodes) != 1 || got.Nodes[0].Name != "riptide" {
		t.Errorf("nodes %+v", got.Nodes)
	}
}

func TestSpireNodesFileListsRevokedAndWaitsForIdentities(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spire-nodes.json")
	nb := &fakeNetBox{devices: []map[string]any{spireDevice("riptide", "active", "attested", nil)}, ifaces: riptideIfaces()}
	r, done := newTest(t, nb, &fakeKube{})
	defer done()
	r.SpireNodesFile = path
	r.Identities = func() ([]Identity, error) { return nil, errors.New("store unreadable") }
	if err := r.Reconcile(context.Background()); err == nil || !strings.Contains(err.Error(), "store unreadable") {
		t.Errorf("reconcile: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("a file was written without the identities: %v", err)
	}
	r.Identities = func() ([]Identity, error) {
		return []Identity{{Machine: "surge", Fingerprint: fpB, NotAfter: testNow.Add(24 * time.Hour), EKHashes: []string{hashB}}}, nil
	}
	_ = r.Reconcile(context.Background())
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got SpireNodes
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Revoked) != 1 || got.Revoked[0].Name != "surge" || got.Revoked[0].LDevIDs[0] != fpB || got.Revoked[0].EKHashes[0] != hashB {
		t.Errorf("file:\n%s", b)
	}
}

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
  ],
  "revoked": []
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
			if n := SpireNodesOf([]Device{{Name: "riptide", Status: c.status, Verdict: c.verdict}}, nil, testNow).Nodes; len(n) != 0 {
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
	}, []Identity{
		{Machine: "Bad_Name", Fingerprint: fpA, NotAfter: testNow.Add(time.Hour)},
		{Machine: "gone", Fingerprint: "XYZ", NotAfter: testNow.Add(time.Hour), EKHashes: []string{"XYZ"}},
	}, testNow)
	if len(nodes.Nodes) != 1 || nodes.Nodes[0].Name != "ok" || len(nodes.Nodes[0].EKHashes) != 1 {
		t.Fatalf("nodes %v", nodes.Nodes)
	}
	if len(nodes.Revoked) != 1 || nodes.Revoked[0].Name != "gone" || len(nodes.Revoked[0].LDevIDs)+len(nodes.Revoked[0].EKHashes) != 0 {
		t.Fatalf("revoked %v", nodes.Revoked)
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

// An ECC pin fleetd cleared, null in NetBox after a pass against an
// RSA-only binding, leaves the RSA EK alone registered.
func TestSpireNodesDropAClearedPin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "spire-nodes.json")
	reconcileSpire(t, path, spireDevice("riptide", "active", "attested", map[string]any{"ek_hash": hashB, "ek_hash_ecc": nil}))
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), hashA) || !strings.Contains(string(got), `"ek_hashes": [
        "`+hashB+`"
      ]`) {
		t.Errorf("file:\n%s", got)
	}
}
