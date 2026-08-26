package cutover

import (
	"strings"
	"testing"
)

// The sanctioned plan, explored in every order the operator could execute it
// in, never reaches a state that breaks an invariant — and still reaches Done,
// so the guards are not vacuously safe.
func TestGuardedCutoverHasNoSafeOrderingThatBreaks(t *testing.T) {
	p := Params{Guarded: true}
	bad, done, visited := Search(p, 10)
	for _, tr := range bad {
		t.Errorf("reachable violation:\n%s", tr)
	}
	if !done {
		t.Error("the guarded plan cannot reach a finished cutover; the guards are too strong")
	}
	t.Logf("explored %d reachable states", visited)
}

// The runbook a human follows at 2am is the same sequence the model checked.
func TestRunbookPlanReplaysClean(t *testing.T) {
	if _, err := Replay(Params{Guarded: true}, RunbookPlan); err != nil {
		t.Fatalf("CUTOVER.md sequence: %v", err)
	}
	states, _ := Replay(Params{Guarded: true}, RunbookPlan)
	if final := states[len(states)-1]; !final.Done() {
		t.Fatal("the runbook sequence runs clean but does not finish the cutover")
	}
}

// Without the guards, the orderings that break are reachable. This is the
// finding, not a regression: each trace below is a plausible sequence.
func TestUnguardedCutoverIsReachablyBroken(t *testing.T) {
	bad, _, visited := Search(Params{}, 8)
	if len(bad) == 0 {
		t.Fatal("the unguarded model found nothing, which means it models nothing")
	}
	for _, tr := range bad {
		t.Logf("reachable violation:\n%s", tr)
	}
	t.Logf("explored %d reachable states, %d distinct violations reported", visited, len(bad))

	// The specific orderings this ticket exists to rule out.
	want := []string{
		"anchors are in caFile",
		"same kid appears twice",
		"without pki:verify",
	}
	var all string
	for _, tr := range bad {
		all += strings.Join(tr.Violations, "\n")
	}
	for _, w := range want {
		if !strings.Contains(all, w) {
			t.Errorf("the unguarded search never reached %q", w)
		}
	}
}

// A rebuild changes files on disk and restarts nothing: sops-nix compares
// decrypted plaintext and the cluster CA and signer keys are unchanged, so
// cfssl keeps serving the certificate it started with and
// kube-controller-manager never republishes kube-root-ca.crt.
func TestRebuildAloneLeavesCfsslAndKCMStale(t *testing.T) {
	plan := []string{
		"ceremony: mint anchors (pathLen 2 / 1)",
		"1password: preserve the superseded Intermediate item",
		"1password: publish the new ca.crt and ca.key",
		"atlantis: apply terraform/pki",
		"scripts/pki/post-rotate.sh folly",
		"scripts/pki/post-rotate.sh offsite",
		"mise run pki:verify",
		"git: merge terraform/pki/certs to main",
		"nixos-rebuild folly",
	}
	states, err := Replay(Params{Guarded: true}, plan)
	if err != nil {
		t.Fatal(err)
	}
	s := states[len(states)-1]
	if s.ClosureChain[folly].Root != genNew {
		t.Fatal("the rebuild did not put the new chain on disk")
	}
	if s.Cfssl[folly] != genOld {
		t.Error("cfssl updated on rebuild; the model no longer matches sops-nix")
	}
	if s.KCMPub[folly].Root != genOld {
		t.Error("kube-controller-manager republished kube-root-ca.crt on rebuild; the model no longer matches sops-nix")
	}
	if s.PodCA[folly].Root != genOld {
		t.Error("pods saw the new chain without a kube-controller-manager restart")
	}
}

// The pivot. Keeping the per-cluster Kubernetes CA key is what makes this a
// cutover with no maintenance window: every certificate the API server serves
// verifies under both the retiring and the incoming anchors, so Go clients
// never notice. Rotate that key in the same change and the identical sequence
// locks clients out, because caFile and cfssl move at different moments and
// nothing bridges them.
func TestRotatingTheClusterCAKeyReintroducesTheWindow(t *testing.T) {
	p := Params{Guarded: true, RotateClusterCAKey: true}
	if _, err := Replay(p, RunbookPlan); err == nil {
		t.Fatal("rotating the cluster CA key was expected to break the same plan")
	} else {
		t.Logf("as expected: %v", err)
	}
	bad, _, _ := Search(p, 3)
	if len(bad) == 0 {
		t.Fatal("no ordering broke, so the argument for preserving the cluster CA key is unsupported")
	}
	t.Logf("shortest trace to a lockout:\n%s", bad[0])
}

// post-rotate.sh rewrites fml-root.pem and fml-intermediate.pem unconditionally
// but only the named cluster's CA and chain, so running it for one cluster
// leaves the committed tree incoherent. pki:verify is the only thing that
// notices, and it is the reason the merge is gated on it.
func TestPostRotateForOneClusterLeavesTheTreeIncoherent(t *testing.T) {
	plan := []string{
		"ceremony: mint anchors (pathLen 2 / 1)",
		"1password: preserve the superseded Intermediate item",
		"1password: publish the new ca.crt and ca.key",
		"atlantis: apply terraform/pki",
		"scripts/pki/post-rotate.sh folly",
		"mise run pki:verify",
	}
	states, err := Replay(Params{Guarded: true}, plan)
	if err != nil {
		t.Fatal(err)
	}
	s := states[len(states)-1]
	if s.Verified {
		t.Fatal("pki:verify passed on a tree whose offsite CA no longer chains to the committed intermediate")
	}
	// And the merge that would deploy it is refused.
	if _, err := Replay(Params{Guarded: true}, append(plan, "git: merge terraform/pki/certs to main")); err == nil {
		t.Fatal("an unverified tree reached main")
	}
}

// The anchor fault nothing in the cluster reports. Go's crypto/x509 anchors on
// the published cluster CA and never walks up, so kubectl, Flux, Prometheus and
// every smoke test stay green on anchors that forbid the depth beneath them;
// only full-path validators refuse. pki:verify is the single thing between that
// mistake and the fleet, and hosts auto-upgrade from main.
func TestPathLenZeroAnchorsAreCaughtOnlyByVerify(t *testing.T) {
	prefix := []string{
		"ceremony: mint anchors (pathLen 0 — the Go zero value)",
		"1password: preserve the superseded Intermediate item",
		"1password: publish the new ca.crt and ca.key",
		"atlantis: apply terraform/pki",
		"scripts/pki/post-rotate.sh folly",
		"scripts/pki/post-rotate.sh offsite",
		"mise run pki:verify",
	}
	states, err := Replay(Params{Guarded: true}, prefix)
	if err != nil {
		t.Fatal(err)
	}
	s := states[len(states)-1]
	if !s.certsCoherent() {
		t.Fatal("the tree links correctly; the fault is the constraint, not the linkage")
	}
	if s.Verified {
		t.Fatal("pki:verify passed on anchors that forbid the CAs beneath them")
	}
	if _, err := Replay(Params{Guarded: true}, append(prefix, "git: merge terraform/pki/certs to main")); err == nil {
		t.Fatal("pathLen-0 anchors reached main")
	}

	// The tree links perfectly and is still unusable by anything that builds a
	// full path, which is the shape of the fault: linkage is fine, the
	// constraint is not.
	if s.opensslUsable(s.FileChain[folly]) {
		t.Fatal("a pathLen-0 root was treated as usable by a full-path validator")
	}
	deployed := s
	deployed.Committed = true
	deployed.ClosureChain[folly] = deployed.FileChain[folly]
	v := deployed.violations(Params{})
	if len(v) == 0 || !strings.Contains(strings.Join(v, "\n"), "--root-ca-file on disk") {
		t.Fatalf("deploying pathLen-0 anchors was expected to break every OpenSSL client, got %v", v)
	}
	t.Logf("skipping pki:verify deploys: %v", v)
}
