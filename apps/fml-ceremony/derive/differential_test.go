package derive

// Differential check of this package against apps/fml-derive-rs, an independent
// Rust implementation of SPEC.md written from the spec text alone by an agent
// forbidden from reading this code. A disagreement is therefore signal: one of
// the two is wrong, or SPEC.md is ambiguous, and the ambiguous case is the one
// worth finding.
//
// The Rust side is a CLI printing one derived value per invocation, so this
// file mirrors that command-line contract onto this package's functions and
// compares stdout byte for byte. The mirror routes into Branch, Leaf and the
// key mappings; it reimplements none of them.
//
// Skipped unless FML_DERIVE_RS names the built binary. `mise run pki:crosscheck`
// builds it and sets the variable.

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
)

// crossCase is one invocation of the Rust CLI and its mirror here. A nil
// length means "omit --len", which the CLI defaults to 32. It is a pointer and
// not a zero sentinel because --len 0 is itself a case worth putting: it is
// where the two implementations first disagreed.
type crossCase struct {
	master string // hex
	path   string
	form   string // hex | prk | ed25519-pub | age-identity | age-recipient | bip39
	length *int
}

func ln(n int) *int { return &n }

func (c crossCase) args() []string {
	a := []string{c.master, c.path}
	if c.length != nil {
		a = append(a, "--len", strconv.Itoa(*c.length))
	}
	if c.form != "" && c.form != "hex" {
		a = append(a, "--as", c.form)
	}
	return a
}

func (c crossCase) String() string {
	return strings.Join(c.args(), " ")
}

// goAnswer is the Rust CLI's contract expressed over this package: decode the
// master, classify the path by component count, derive, then map by form. It
// deliberately adds no validation of its own — every rejection below comes out
// of SplitPath, Branch, Leaf or a key mapping, so what is compared is the two
// implementations rather than two argument parsers.
func goAnswer(c crossCase) (string, error) {
	master, err := hex.DecodeString(c.master)
	if err != nil {
		return "", err
	}
	parts, err := SplitPath(c.path)
	if err != nil {
		return "", err
	}
	// The master-length check lives inside derive_branch and prk_master on the
	// Rust side; every reachable form below passes through one of them.
	if len(master) != SeedLen {
		return "", fmt.Errorf("master seed is %d octets, want %d", len(master), SeedLen)
	}

	if len(parts) == 3 {
		if c.length != nil {
			return "", errors.New("--len does not apply to a branch path")
		}
		switch c.form {
		case "", "hex":
			secret, err := Branch(master, c.path)
			if err != nil {
				return "", err
			}
			return hex.EncodeToString(secret), nil
		case "prk":
			prk, err := branchPRK(master)
			if err != nil {
				return "", err
			}
			return hex.EncodeToString(prk), nil
		default:
			return "", fmt.Errorf("--as %s does not apply to a branch path", c.form)
		}
	}
	if len(parts) < 5 {
		return "", fmt.Errorf("path %q is neither a branch nor a leaf", c.path)
	}

	branch := strings.Join(parts[:3], "/")
	secret, err := Branch(master, branch)
	if err != nil {
		return "", err
	}
	if c.form == "prk" {
		prk, err := leafPRK(secret)
		if err != nil {
			return "", err
		}
		return hex.EncodeToString(prk), nil
	}

	l := 32
	if c.length != nil {
		l = *c.length
	}
	okm, err := Leaf(secret, branch, c.path, l)
	if err != nil {
		return "", err
	}
	switch c.form {
	case "", "hex":
		return hex.EncodeToString(okm), nil
	case "ed25519-pub":
		priv, err := Ed25519FromOKM(okm)
		if err != nil {
			return "", err
		}
		return hex.EncodeToString(priv.Public().(ed25519.PublicKey)), nil
	case "age-identity":
		identity, _, err := AgeFromOKM(okm)
		return identity, err
	case "age-recipient":
		_, recipient, err := AgeFromOKM(okm)
		return recipient, err
	case "bip39":
		return MnemonicFromEntropy(okm)
	default:
		return "", fmt.Errorf("unknown --as %q", c.form)
	}
}

func rustAnswer(t *testing.T, bin string, c crossCase) (string, error) {
	t.Helper()
	out, err := exec.Command(bin, c.args()...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return "", fmt.Errorf("exit %d: %s", ee.ExitCode(), strings.TrimSpace(string(ee.Stderr)))
		}
		t.Fatalf("running %s: %v", bin, err)
	}
	return strings.TrimSuffix(string(out), "\n"), nil
}

// crossMaster is a reproducible generated master: the case list must be
// identical on every machine and in CI, so nothing here is random.
func crossMaster(i int) string {
	sum := sha256.Sum256([]byte("fml-crosscheck/" + strconv.Itoa(i)))
	return hex.EncodeToString(sum[:])
}

// crossCases is the case list: every SPEC.md section 11 master, ten generated
// ones, every branch, every declared leaf, every key type, both PRK levels,
// undeclared-but-well-formed paths a verifier may derive, and the lengths of
// section 4.3.
func crossCases() []crossCase {
	masters := []string{
		strings.Repeat("00", 32), // vector A
		"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", // vector B
		"2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218", // vector C
	}
	for i := range 10 {
		masters = append(masters, crossMaster(i))
	}

	forms := map[KeyType]string{
		KeyEd25519: "ed25519-pub",
		KeyAge:     "age-recipient",
		KeyBIP39:   "bip39",
	}

	var cases []crossCase
	for _, m := range masters {
		for _, b := range MintedBranches {
			cases = append(cases,
				crossCase{master: m, path: b},
				crossCase{master: m, path: b, form: "prk"},
			)
		}
		for _, d := range V1Tree {
			cases = append(cases,
				crossCase{master: m, path: d.Path},
				crossCase{master: m, path: d.Path, form: "prk"},
				crossCase{master: m, path: d.Path, form: forms[d.Type]},
			)
			if d.Type == KeyAge {
				cases = append(cases, crossCase{master: m, path: d.Path, form: "age-identity"})
			}
		}
		// Paths outside the minted tree. Neither implementation is the
		// ceremony, and SPEC.md section 9 lets a verifier derive anything
		// well-formed, so these must agree too — including under the reserved
		// names, where the refusal lives above the derivation library.
		cases = append(cases,
			crossCase{master: m, path: "fml/infra/v2"},
			crossCase{master: m, path: "fml/kms/v1"},
			crossCase{master: m, path: "fml/ssh/v9"},
			crossCase{master: m, path: "fml/infra/v1/pki/root/v2"},
			crossCase{master: m, path: "fml/infra/v1/pki/root/v2", form: "ed25519-pub"},
			crossCase{master: m, path: "fml/infra/v1/age/backup/v1", form: "age-identity"},
			crossCase{master: m, path: "fml/infra/v1/age/backup/v1", form: "age-recipient"},
			crossCase{master: m, path: "fml/wallet/v1/hot/v3", form: "bip39"},
			crossCase{master: m, path: "fml/kms/v1/root/v1"},
			crossCase{master: m, path: "fml/a-b/v17/c-d/e9/v2"},
			crossCase{master: m, path: "fml/infra/v11/pki/root/v1"},
			// Section 4.3: L is not bound into the expansion input.
			crossCase{master: m, path: "fml/infra/v1/pki/root/v1", length: ln(16)},
			crossCase{master: m, path: "fml/infra/v1/pki/root/v1", length: ln(48)},
			crossCase{master: m, path: "fml/infra/v1/pki/root/v1", length: ln(64)},
			// 8160 = 255 x HashLen, RFC 5869's ceiling; 16 and 20 octets are the
			// other BIP-39 entropy sizes, so the mnemonic mapping is exercised at
			// three word counts rather than only at 24.
			crossCase{master: m, path: "fml/infra/v1/pki/root/v1", length: ln(8160)},
			crossCase{master: m, path: "fml/wallet/v1/cold/v1", length: ln(16), form: "bip39"},
			crossCase{master: m, path: "fml/wallet/v1/cold/v1", length: ln(20), form: "bip39"},
			// Section 3.1's bounds from the accepting side: exactly 128 octets
			// and exactly 16 components are legal.
			crossCase{master: m, path: "fml/" + strings.Repeat("a", 121) + "/v1"},
			crossCase{master: m, path: "fml/a/v1/b/c/d/e/f/g/h/i/j/k/l/m/v2"},
			// Hex is case-insensitive at the input boundary but the master it
			// decodes to is the same, so the derived value must be identical.
			crossCase{master: strings.ToUpper(m), path: "fml/infra/v1"},
		)
	}
	return cases
}

// crossRejects are inputs SPEC.md section 9 requires an implementation to
// abort on. Error text is not compared — only that both refuse.
func crossRejects() []crossCase {
	const good = "2d85dabefa504eefea7740977b1f9110daf404cc24422896a209b41eca970218"
	var cases []crossCase
	for _, p := range []string{
		"", "/fml/infra/v1", "fml/infra/v1/", "fml//infra/v1",
		"FML/infra/v1", "fml/Infra/v1", "fml/in_fra/v1", "fml/in.fra/v1",
		"fml/in fra/v1", "fml/inféra/v1", "fml/1nfra/v1", "fml/-infra/v1",
		"fml/infra/v0", "fml/infra/v01", "fml/infra/V1", "fml/infra/v1.0",
		"fml/infra/v", "fml/infra", "infra/pki/v1", "not-fml/infra/v1",
		"fml/v1", "fml/infra/v1/v2", // 2 and 4 components: neither branch nor leaf
		"fml/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/v1",
		"fml/a/v1/b/c/d/e/f/g/h/i/j/k/l/m/n/v2", // 17 components, one over
		"fml/" + strings.Repeat("a", 130) + "/v1",
		"fml/" + strings.Repeat("a", 122) + "/v1", // 129 octets, one over
		"fml/infra/v1/pki/root/v1 ",               // trailing space
		"fml/infra/v1/pki/root/v1\n",              // trailing newline
	} {
		cases = append(cases, crossCase{master: good, path: p})
	}
	// Malformed masters, and lengths section 2 forbids.
	for _, m := range []string{
		"", "abc", "0x" + good[2:], "zz" + good[2:],
		strings.Repeat("00", 31), strings.Repeat("00", 33), strings.Repeat("00", 64),
	} {
		cases = append(cases, crossCase{master: m, path: "fml/infra/v1"})
		cases = append(cases, crossCase{master: m, path: "fml/infra/v1/pki/root/v1"})
	}
	// Section 3.4: the branch prefix must land on a component boundary. The CLI
	// takes the branch from the leaf's own first three components, so the only
	// way to reach the mismatch through it is a leaf whose declared branch is
	// not its prefix — covered by the Go-side unit tests. What the CLI can show
	// is that a mapping refuses an OKM of the wrong length.
	cases = append(cases,
		crossCase{master: good, path: "fml/infra/v1/pki/root/v1", length: ln(31), form: "ed25519-pub"},
		crossCase{master: good, path: "fml/infra/v1/age/operator/v1", length: ln(33), form: "age-recipient"},
		crossCase{master: good, path: "fml/wallet/v1/cold/v1", length: ln(15), form: "bip39"},
		crossCase{master: good, path: "fml/infra/v1", length: ln(32)},
		crossCase{master: good, path: "fml/infra/v1", form: "ed25519-pub"},
		crossCase{master: good, path: "fml/infra/v1/pki/root/v1", form: "nonsense"},
		// L outside 1..255 x HashLen. RFC 5869 caps expansion at 255 blocks, and
		// an L of zero is not key material -- SPEC.md section 5.2 states the
		// range because this is exactly where two implementations drifted.
		crossCase{master: good, path: "fml/infra/v1/pki/root/v1", length: ln(0)},
		crossCase{master: good, path: "fml/infra/v1/pki/root/v1", length: ln(-1)},
		crossCase{master: good, path: "fml/infra/v1/pki/root/v1", length: ln(8161)},
	)
	return cases
}

func TestDifferentialAgainstRust(t *testing.T) {
	bin := os.Getenv("FML_DERIVE_RS")
	if bin == "" {
		t.Skip("FML_DERIVE_RS unset; run `mise run pki:crosscheck` to build the Rust side and set it")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("FML_DERIVE_RS=%s: %v", bin, err)
	}

	agreed := 0
	for _, c := range crossCases() {
		want, goErr := goAnswer(c)
		got, rustErr := rustAnswer(t, bin, c)
		switch {
		case goErr != nil && rustErr != nil:
			t.Errorf("both refused a case meant to succeed: %s\n  go:   %v\n  rust: %v", c, goErr, rustErr)
		case goErr != nil:
			t.Errorf("go refused, rust returned %q: %s\n  go: %v", got, c, goErr)
		case rustErr != nil:
			t.Errorf("rust refused, go returned %q: %s\n  rust: %v", want, c, rustErr)
		case got != want:
			t.Errorf("DISAGREEMENT: %s\n  go:   %s\n  rust: %s", c, want, got)
		default:
			agreed++
		}
	}
	for _, c := range crossRejects() {
		_, goErr := goAnswer(c)
		_, rustErr := rustAnswer(t, bin, c)
		switch {
		case goErr == nil && rustErr == nil:
			t.Errorf("both accepted an input SPEC.md section 9 rejects: %s", c)
		case goErr == nil:
			t.Errorf("go accepted what rust rejected: %s\n  rust: %v", c, rustErr)
		case rustErr == nil:
			t.Errorf("rust accepted what go rejected: %s\n  go: %v", c, goErr)
		default:
			agreed++
		}
	}
	t.Logf("%d cases agree byte for byte", agreed)
}

// TestDifferentialRoutesInCI is the guard on the guard. Routing in this repo is
// an allow-list, and the differential is the one check that needs *two* trees to
// route to it: go.yml runs `go test ./...` here, where the test above skips
// itself for want of a Rust binary, so a Go-side change reaching only go.yml
// would report green having compared nothing.
func TestDifferentialRoutesInCI(t *testing.T) {
	raw, err := os.ReadFile("../../../.github/workflows/rust.yml")
	if err != nil {
		t.Fatal(err)
	}
	yml := string(raw)
	// Twice each: once under push, once under pull_request.
	for _, want := range []string{"apps/fml-ceremony/**", "apps/fml-derive-rs/**"} {
		if strings.Count(yml, want) < 2 {
			t.Errorf(".github/workflows/rust.yml does not route %q on both push and pull_request; a change there would run the differential nowhere and go green", want)
		}
	}
	if !strings.Contains(yml, "FML_DERIVE_RS") {
		t.Error(".github/workflows/rust.yml no longer sets FML_DERIVE_RS, so the differential job skips itself and passes")
	}
}
