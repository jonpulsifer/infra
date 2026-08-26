package cutover

import (
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A model of a cutover is fiction unless it is pinned to the tree it claims to
// describe. These assertions read the committed files and the NixOS wiring and
// fail when reality moves, so the state machine above cannot quietly drift into
// describing an estate that no longer exists.
//
// They deliberately do not repeat what `mise run pki:verify` already asserts —
// linkage, signatures, CA:TRUE, pathLen depth, expiry ordering. That check runs
// as its own job in .github/workflows/go.yml.

const repoRoot = "../../.."

func certsDir() string { return filepath.Join(repoRoot, "terraform", "pki", "certs") }

func readCerts(t *testing.T, path string) []*x509.Certificate {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out []*x509.Certificate
	for {
		var blk *pem.Block
		blk, raw = pem.Decode(raw)
		if blk == nil {
			break
		}
		c, err := x509.ParseCertificate(blk.Bytes)
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		t.Fatalf("%s: no certificates", path)
	}
	return out
}

// caFile is <cluster>-ca-bundle.pem and also backs clientCaFile and
// kubeletClientCaFile. An FML anchor in it turns every certificate issued
// anywhere under the FML Root into an authentication credential, and one
// carrying O=system:masters into cluster-admin.
func TestCABundleCarriesOnlyClusterCAs(t *testing.T) {
	for _, cluster := range clusterName {
		path := filepath.Join(certsDir(), cluster+"-ca-bundle.pem")
		for i, c := range readCerts(t, path) {
			if !strings.HasPrefix(c.Subject.CommonName, "FML K8s "+cluster) {
				t.Errorf("%s[%d] is %q — caFile backs clientCaFile and kubeletClientCaFile, so only this cluster's CA may appear there",
					filepath.Base(path), i, c.Subject.CommonName)
			}
		}
	}
}

// The chain file is the one an OpenSSL client has to build a whole path out of:
// cluster CA, Intermediate, self-signed Root, and every link present.
func TestChainFileIsAWholePathToASelfSignedRoot(t *testing.T) {
	for _, cluster := range clusterName {
		path := filepath.Join(certsDir(), cluster+"-ca-chain.pem")
		chain := readCerts(t, path)
		if len(chain) != 3 {
			t.Fatalf("%s holds %d certificates, want cluster CA + Intermediate + Root", filepath.Base(path), len(chain))
		}
		for i := range len(chain) - 1 {
			if err := chain[i].CheckSignatureFrom(chain[i+1]); err != nil {
				t.Errorf("%s[%d] %q is not signed by [%d] %q: %v",
					filepath.Base(path), i, chain[i].Subject.CommonName, i+1, chain[i+1].Subject.CommonName, err)
			}
		}
		root := chain[2]
		if err := root.CheckSignatureFrom(root); err != nil {
			t.Errorf("%s does not terminate in a self-signed root: %v", filepath.Base(path), err)
		}
	}
}

// The re-birth's whole no-maintenance-window argument: the per-cluster
// Kubernetes CA key survives, so its subjectKeyIdentifier survives, so every
// certificate cfssl has already issued still names an issuer that exists. If
// this ever stops holding, the cutover needs an overlap bundle and a window —
// see TestRotatingTheClusterCAKeyReintroducesTheWindow.
func TestIssuedCertsNameTheClusterCAByAnIdentifierTheRebirthDoesNotChange(t *testing.T) {
	for _, cluster := range clusterName {
		ca := readCerts(t, filepath.Join(certsDir(), cluster+"-ca.pem"))[0]
		if len(ca.SubjectKeyId) == 0 {
			t.Fatalf("%s-ca.pem carries no subjectKeyIdentifier, so nothing beneath it names an issuer", cluster)
		}
		signer := readCerts(t, filepath.Join(certsDir(), cluster+"-sa-signer.pem"))[0]
		if string(signer.AuthorityKeyId) != string(ca.SubjectKeyId) {
			t.Errorf("%s-sa-signer.pem names issuer %x, but %s-ca.pem is %x",
				cluster, signer.AuthorityKeyId, cluster, ca.SubjectKeyId)
		}
	}
}

// A duplicate kid resolves a token against whichever entry the apiserver reads
// first. The re-birth reissues the signer certificate for an unchanged key, so
// exactly one entry is correct — a second is the "treat a reissue as a
// rotation" mistake.
func TestJWKSPublishesNoDuplicateKid(t *testing.T) {
	for _, cluster := range clusterName {
		path := filepath.Join(repoRoot, "terraform", "pki", "oidc", cluster, "jwks.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Keys []struct{ Kid string } `json:"keys"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, k := range doc.Keys {
			if seen[k.Kid] {
				t.Errorf("%s publishes kid %q twice", path, k.Kid)
			}
			seen[k.Kid] = true
		}
	}
}

// The model assumes a specific wiring: the bundle in caFile, the chain in
// --root-ca-file, and neither swapped for the other.
func TestNixWiresTheBundleAndTheChainToDifferentOptions(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot, "nix", "services", "k8s", "default.nix"))
	if err != nil {
		t.Fatal(err)
	}
	nix := string(raw)
	for _, want := range []string{
		`fmlClusterCaBundle = ../../../terraform/pki/certs/${cfg.network}-ca-bundle.pem;`,
		`fmlClusterCaChain = ../../../terraform/pki/certs/${cfg.network}-ca-chain.pem;`,
		`"L+ /var/lib/kubernetes/secrets/ca.pem - - - - ${fmlClusterCaBundle}"`,
		`caFile = "/var/lib/kubernetes/secrets/ca.pem";`,
		`rootCaFile = lib.mkIf cfg.clusterCa.enable (lib.mkForce fmlClusterCaChain);`,
	} {
		if !strings.Contains(nix, want) {
			t.Errorf("nix/services/k8s/default.nix no longer contains %q; the model's wiring assumption is stale", want)
		}
	}
	if strings.Contains(nix, "caFile = ") && strings.Contains(nix, "caFile = fmlClusterCaChain") {
		t.Error("the chain reached caFile, which also backs clientCaFile and kubeletClientCaFile")
	}
}

// The runbook a human follows and the sequence the model checked are the same
// list, in the same order.
func TestCutoverDocMatchesTheCheckedPlan(t *testing.T) {
	raw, err := os.ReadFile("CUTOVER.md")
	if err != nil {
		t.Fatal(err)
	}
	doc := string(raw)
	at := 0
	for i, step := range RunbookPlan {
		idx := strings.Index(doc[at:], step)
		if idx < 0 {
			t.Fatalf("CUTOVER.md does not list step %d %q in order", i+1, step)
		}
		at += idx + len(step)
	}
}

// CI routing in this repo is an allow-list: a path no workflow names runs no
// jobs and still reports green. These checks are worthless if a change to the
// certificates does not reach them.
func TestCertChangesRouteToThisWorkflow(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(repoRoot, ".github", "workflows", "go.yml"))
	if err != nil {
		t.Fatal(err)
	}
	yml := string(raw)
	for _, want := range []string{"terraform/pki/certs/**", "apps/fml-ceremony/**", "apps/fml-attest/**"} {
		if strings.Count(yml, want) < 2 {
			t.Errorf(".github/workflows/go.yml does not route %q on both push and pull_request; a certificate change would run no jobs and go green", want)
		}
	}
}
