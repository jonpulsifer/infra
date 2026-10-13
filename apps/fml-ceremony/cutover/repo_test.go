package cutover

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These tests pin the model to the committed files. They skip
// what `mise run pki:verify` checks, which runs as its own job in go.yml.

const repoRoot = "../../.."

// Both clusters run Talos, so their cluster CAs are their secrets bundles' own, outside the FML
// chain, and no cluster-CA file is committed under terraform/pki/certs.

// A duplicate kid resolves a token against whichever entry the apiserver reads first.
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

// CI routing is an allow-list: a path no workflow names runs no jobs and still
// reports green.
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
