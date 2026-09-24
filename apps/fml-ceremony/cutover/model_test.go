package cutover

import (
	"strings"
	"testing"
)

// Done must stay reachable, or the guards are vacuously safe.
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

func TestRunbookPlanReplaysClean(t *testing.T) {
	if _, err := Replay(Params{Guarded: true}, RunbookPlan); err != nil {
		t.Fatalf("CUTOVER.md sequence: %v", err)
	}
	states, _ := Replay(Params{Guarded: true}, RunbookPlan)
	if final := states[len(states)-1]; !final.Done() {
		t.Fatal("the runbook sequence runs clean but does not finish the cutover")
	}
}

func TestUnguardedCutoverIsReachablyBroken(t *testing.T) {
	bad, _, visited := Search(Params{}, 8)
	if len(bad) == 0 {
		t.Fatal("the unguarded model found nothing, which means it models nothing")
	}
	for _, tr := range bad {
		t.Logf("reachable violation:\n%s", tr)
	}
	t.Logf("explored %d reachable states, %d distinct violations reported", visited, len(bad))

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

// sops-nix compares decrypted plaintext and the keys are unchanged, so a
// rebuild restarts neither cfssl nor kube-controller-manager.
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

// Keeping the cluster CA key lets Go clients verify under both anchor
// generations. Rotating it breaks the plan: caFile and cfssl move at different times.
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

// post-rotate.sh for one cluster rewrites the shared anchors but only that
// cluster's CA and chain. Only pki:verify notices, so the merge waits on it.
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
	if _, err := Replay(Params{Guarded: true}, append(plan, "git: merge terraform/pki/certs to main")); err == nil {
		t.Fatal("an unverified tree reached main")
	}
}

// Go anchors on the published cluster CA, so kubectl, Flux and Prometheus stay
// green on pathLen:0 anchors. Only full-path validators and pki:verify refuse them.
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
