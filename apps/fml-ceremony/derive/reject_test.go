package derive

import (
	"encoding/hex"
	"strings"
	"testing"
)

// TestVectorD is SPEC.md's versioning-and-length vector. It asserts two things
// the design leans on: a branch version bump really does rotate, and the L=32
// output is a literal prefix of the L=64 output, which is why a leaf's key type
// is pinned by the tree declaration rather than chosen at the call site.
func TestVectorD(t *testing.T) {
	master := mustHex(t, strings.Repeat("00", 32))

	v1, err := Branch(master, "fml/infra/v1")
	if err != nil {
		t.Fatal(err)
	}
	v2, err := Branch(master, "fml/infra/v2")
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(v1); got != "4f48ab1c12e7fb032b6293447491ce8e7811f0f198dbc6246bbeef5e235b6d37" {
		t.Fatalf("fml/infra/v1 = %s", got)
	}
	if got := hex.EncodeToString(v2); got != "5879f6d9b2990dfff021c69b368076922714324a960ad13b3a7089543ec50772" {
		t.Fatalf("fml/infra/v2 = %s", got)
	}

	rootV2, err := Leaf(v1, "fml/infra/v1", "fml/infra/v1/pki/root/v2", 32)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(rootV2); got != "b18d6a4889e2a49c71d6f16ba23a54b6b809c5f4118ad87f3e9d923c1c80b1b8" {
		t.Fatalf("pki/root/v2 okm = %s", got)
	}
	pub, err := Ed25519FromOKM(rootV2)
	if err != nil {
		t.Fatal(err)
	}
	if got := hex.EncodeToString(pub[32:]); got != "6ffa17c288136cfe8a72612beea298ae52ded45a6259ce751f974d6ba2775807" {
		t.Fatalf("pki/root/v2 public = %s", got)
	}

	long, err := Leaf(v1, "fml/infra/v1", "fml/infra/v1/pki/root/v1", 64)
	if err != nil {
		t.Fatal(err)
	}
	want := "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c" +
		"81257eabe32ce08b6e97f5f5806897fa13c59c084670e6d71af5cedc64f72500"
	if got := hex.EncodeToString(long); got != want {
		t.Fatalf("L=64 okm = %s", got)
	}
	// Not a curiosity: RFC 5869 does not bind L into the expansion input, so a
	// leaf declared at two lengths would be prefix-related rather than
	// independent. SPEC.md 4.3 exists because of this line.
	if !strings.HasPrefix(hex.EncodeToString(long), "08b07ea669f9329cae8cb7728d0904273a34c88de605c5e67116d42c1b4fb13c") {
		t.Fatal("L=32 is no longer a prefix of L=64")
	}
}

func TestPathRejection(t *testing.T) {
	for _, p := range []string{
		"",
		"/fml/infra/v1",
		"fml/infra/v1/",
		"fml//infra/v1",
		"FML/infra/v1",
		"fml/Infra/v1",
		"fml/in_fra/v1",
		"fml/in.fra/v1",
		"fml/in fra/v1",
		"fml/inféra/v1",
		"fml/1nfra/v1",
		"fml/-infra/v1",
		"fml/infra/v0",
		"fml/infra/v01",
		"fml/infra/V1",
		"fml/infra/v1.0",
		"fml/infra/v",
		"fml/infra",
		"infra/pki/v1",
		"fml/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/v1",
		"fml/" + strings.Repeat("a", 130) + "/v1",
	} {
		if _, err := SplitPath(p); err == nil {
			t.Errorf("SplitPath(%q) accepted", p)
		}
	}
	for _, p := range []string{"fml/v1", "fml/infra/v1", "fml/infra/v1/pki/root/v17", "fml/a-b/v2"} {
		if _, err := SplitPath(p); err != nil {
			t.Errorf("SplitPath(%q): %v", p, err)
		}
	}
}

func TestBranchAndLeafShape(t *testing.T) {
	if err := CheckBranchPath("fml/infra/v1/pki/v1"); err == nil {
		t.Error("a 5-component path was accepted as a branch")
	}
	if err := CheckBranchPath("fml/v1"); err == nil {
		t.Error("a 2-component path was accepted as a branch")
	}
	if err := CheckLeafPath("fml/infra/v1", "fml/infra/v1/v2"); err == nil {
		t.Error("a 4-component leaf was accepted")
	}
	// The check that stops the wallet-branch holder from minting an
	// infra-looking key nobody can reproduce.
	if err := CheckLeafPath("fml/wallet/v1", "fml/infra/v1/pki/root/v1"); err == nil {
		t.Error("a leaf outside its branch was accepted")
	}
	// A prefix match must be on a component boundary: fml/infra/v1 must not
	// swallow fml/infra/v11.
	if err := CheckLeafPath("fml/infra/v1", "fml/infra/v11/pki/root/v1"); err == nil {
		t.Error("a sibling branch was accepted as a descendant")
	}
}

func TestSeedLengthRejection(t *testing.T) {
	for _, n := range []int{0, 16, 31, 33, 64} {
		if _, err := Branch(make([]byte, n), "fml/infra/v1"); err == nil {
			t.Errorf("a %d-octet master seed was accepted", n)
		}
		if _, err := Leaf(make([]byte, n), "fml/infra/v1", "fml/infra/v1/pki/root/v1", 32); err == nil {
			t.Errorf("a %d-octet branch secret was accepted", n)
		}
	}
}

// TestCeremonyMasterSplit is SPEC.md section 9's deliberate asymmetry: the
// library must derive from the all-zero master because vector A depends on it,
// and the ceremony must refuse the same seed because a constant means entropy
// collection failed.
func TestCeremonyMasterSplit(t *testing.T) {
	for _, seed := range [][]byte{make([]byte, 32), mustHex(t, strings.Repeat("ff", 32))} {
		if _, err := Branch(seed, "fml/infra/v1"); err != nil {
			t.Errorf("the derivation library refused a constant master: %v", err)
		}
		if err := CheckCeremonyMaster(seed); err == nil {
			t.Error("the ceremony accepted a constant master")
		}
	}
	if err := CheckCeremonyMaster(mustHex(t, "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218")); err != nil {
		t.Errorf("the ceremony refused a real master: %v", err)
	}
}

func TestTreeMembership(t *testing.T) {
	for _, p := range []string{
		"fml/kms/v1/root/v1",
		"fml/ssh/v1/ca/v1",
		"fml/infra/v1/pki/root/v2",   // well-formed, undeclared: no implicit "latest"
		"fml/infra/v1/pki/router/v1", // undeclared sibling
		"fml/infra/v2/pki/root/v1",   // undeclared branch version
	} {
		if _, err := Declared(p); err == nil {
			t.Errorf("Declared(%q) accepted an unmintable path", p)
		}
	}
	for _, d := range V1Tree {
		got, err := Declared(d.Path)
		if err != nil {
			t.Fatalf("Declared(%q): %v", d.Path, err)
		}
		if got != d {
			t.Errorf("Declared(%q) = %+v", d.Path, got)
		}
		if err := CheckLeafPath(d.Branch, d.Path); err != nil {
			t.Errorf("declared leaf %q does not descend from %q: %v", d.Path, d.Branch, err)
		}
	}
	// Every declared leaf must hang off a minted branch, or it would have no
	// share set and would die with the master.
	minted := map[string]bool{}
	for _, b := range MintedBranches {
		minted[b] = true
		if err := CheckBranchPath(b); err != nil {
			t.Errorf("minted branch %q: %v", b, err)
		}
	}
	for _, d := range V1Tree {
		if !minted[d.Branch] {
			t.Errorf("leaf %q hangs off unminted branch %q", d.Path, d.Branch)
		}
	}
}

func TestBech32Rejection(t *testing.T) {
	const good = "AGE-SECRET-KEY-1GFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPYYSJZGFPQ4EGAEX"
	for name, s := range map[string]string{
		"mixed case":     "AGE-SECRET-KEY-1gfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpyysjzgfpq4egaex",
		"bad checksum":   good[:len(good)-1] + "Y",
		"charset":        good[:20] + "B" + good[21:],
		"no separator":   "agesecretkeyzzzz",
		"truncated":      good[:10],
		"empty":          "",
		"data too short": "age1qqqqqqqqqqqqqqq",
	} {
		if _, err := AgeIdentityBytes(s); err == nil {
			t.Errorf("%s: accepted %q", name, s)
		}
	}
	// Non-zero padding in the 5-to-8 conversion: append a data character that
	// leaves bits set past the last whole octet, then re-checksum so the only
	// remaining fault is the padding itself.
	lower := strings.ToLower(good)
	sep := strings.LastIndexByte(lower, '1')
	body := lower[sep+1 : len(lower)-6]
	values := make([]byte, 0, len(body)+1)
	for i := 0; i < len(body); i++ {
		values = append(values, byte(strings.IndexByte(charset, body[i])))
	}
	values = append(values, byte(strings.IndexByte(charset, 'p'))) // 0b00001, a set bit in the padding
	hrp := lower[:sep]
	polymod := bech32Polymod(append(append(hrpExpand(hrp), values...), 0, 0, 0, 0, 0, 0)) ^ 1
	var sb strings.Builder
	sb.WriteString(hrp)
	sb.WriteByte('1')
	for _, v := range values {
		sb.WriteByte(charset[v])
	}
	for i := 0; i < 6; i++ {
		sb.WriteByte(charset[polymod>>(5*(5-i))&31])
	}
	if _, err := AgeIdentityBytes(strings.ToUpper(sb.String())); err == nil {
		t.Error("non-zero padding was accepted")
	}
}

func TestBIP39EntropyRejection(t *testing.T) {
	for _, n := range []int{0, 8, 15, 17, 33, 64} {
		if _, err := MnemonicFromEntropy(make([]byte, n)); err == nil {
			t.Errorf("%d-octet entropy was accepted", n)
		}
	}
}
