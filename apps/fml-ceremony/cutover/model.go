// Package cutover models the re-birth of the FML Root and Intermediate CAs
// across the folly and offsite clusters as an explicit state machine, and
// searches every interleaving of the steps for one that leaves a client unable
// to verify something it has to verify.
//
// Why a Go search and not TLA+: the hard part of this cutover is not temporal
// logic, it is bookkeeping — which certificate generation sits in which file,
// which of those files a given client concatenates into one trust store, and
// which services hold a copy in memory that no rebuild replaces. That is a
// struct and a predicate. It also has to stay tied to the repository: the
// checks in repo_test.go read terraform/pki/certs and nix/services/k8s so the
// model fails when reality moves out from under it, which a specification in
// another language cannot do. The state space is small enough that breadth-first
// search is exhaustive in milliseconds, and apps/fml-ceremony is already a Go
// module routed in .github/workflows/go.yml, so the check runs on every PR with
// no new toolchain to keep alive.
//
// The pivot fact the whole model turns on: the re-birth mints new Root and
// Intermediate *keys* but the per-cluster Kubernetes CA keys survive. Every
// certificate the API server serves stays verifiable under both the old and the
// new anchors, which is what makes this a no-maintenance-window operation.
// TestRotatingTheClusterCAKeyReintroducesTheWindow shows what changes the moment
// that stops being true.
package cutover

import (
	"fmt"
	"slices"
)

// gen is which generation of trust material a certificate belongs to: the one
// signed by the retiring anchors, or the one signed by the anchors the ceremony
// minted.
type gen uint8

const (
	genOld gen = iota
	genNew
)

func (g gen) String() string {
	if g == genNew {
		return "new"
	}
	return "old"
}

// Clusters, in the index order every [2]-sized field in State uses.
const (
	folly = iota
	offsite
	numClusters
)

var clusterName = [numClusters]string{"folly", "offsite"}

// chain is the ordered content of <cluster>-ca-chain.pem: the cluster CA, the
// FML Intermediate, the FML Root. An OpenSSL client can only build a path out
// of it when all three come from the same generation — a cluster CA names its
// issuer by the Intermediate's subjectKeyIdentifier, and the re-birth changes
// that identifier because it changes the key behind it.
type chain struct{ CA, Int, Root gen }

func (c chain) homogeneous() bool { return c.CA == c.Int && c.Int == c.Root }

func (c chain) String() string {
	return fmt.Sprintf("{ca:%s int:%s root:%s}", c.CA, c.Int, c.Root)
}

// State is one point in the cutover. Every field is comparable so State works
// directly as a map key for the search.
type State struct {
	// Offline, and in 1Password.

	Minted    bool // the ceremony has produced new Root and Intermediate material
	PathLenOK bool // the minted anchors admit the two CAs beneath them
	OldEscrow bool // the superseded Intermediate item is preserved under its own title
	OPAnchors gen  // the ca.crt / ca.key fields terraform/pki reads at plan time
	OldBurned bool // the superseded anchors are destroyed and cannot come back

	// terraform/pki state.

	TFSigned gen // generation of the Intermediate that signed the four leaf certs

	// terraform/pki/certs, in the working tree and then on main.

	FileRoot  gen
	FileInt   gen
	FileCA    [numClusters]gen   // <cluster>-ca.pem, and <cluster>-ca-bundle.pem beside it
	FileChain [numClusters]chain // <cluster>-ca-chain.pem, written as a unit
	JWKS      [numClusters]int   // entries published in oidc/<cluster>/jwks.json
	Committed bool               // the certs/ edit is merged to main
	Verified  bool               // pki:verify passed against exactly what is on main

	// clusters/offsite/apps/spindrift/ca-bundle.yaml. Written by post-rotate.sh
	// from offsite-ca.pem plus folly-ca-chain.pem, shipped by Flux.

	FileBundleOffsiteCA  gen
	FileBundleFollyChain chain
	LiveBundleOffsiteCA  gen
	LiveBundleFollyChain chain

	// Live, per cluster.

	ClosureCA    [numClusters]gen   // caFile -> /var/lib/kubernetes/secrets/ca.pem
	ClosureChain [numClusters]chain // kube-controller-manager --root-ca-file
	Cfssl        [numClusters]gen   // cfssl's CA, loaded once at unit start
	KCMPub       [numClusters]chain // kube-root-ca.crt, published once at unit start
	PodCA        [numClusters]chain // ca.crt as the kubelet projects it into pods
	PodProc      [numClusters]chain // the store a long-lived process actually holds

	// The forbidden edit: the chain merged into <cluster>-ca-bundle.pem, which
	// backs services.kubernetes.caFile and therefore clientCaFile and
	// kubeletClientCaFile.
	CAFilePoisoned [numClusters]bool
}

// Params selects which model to search.
type Params struct {
	// Guarded runs the sanctioned plan: every action carries the precondition
	// the runbook states. Unguarded lets the operator do the steps in any order
	// and take the two tempting wrong turns, which is how the search finds the
	// orderings that break.
	Guarded bool

	// RotateClusterCAKey asks what the same plan costs if the per-cluster
	// Kubernetes CA key is replaced as well. It is false for the settled
	// re-birth; the model keeps it because the answer is the justification.
	RotateClusterCAKey bool
}

type action struct {
	name    string
	enabled func(State, Params) bool
	apply   func(State, Params) State
}

func always(State, Params) bool { return true }

// actions is the whole vocabulary of the cutover, named the way the runbook
// names them.
func actions(p Params) []action {
	as := []action{
		{
			// The ceremony mints anchors whose pathLenConstraint admits the two
			// CAs beneath the root and the one beneath the intermediate.
			name:    "ceremony: mint anchors (pathLen 2 / 1)",
			enabled: func(s State, _ Params) bool { return !s.Minted },
			apply: func(s State, _ Params) State {
				s.Minted, s.PathLenOK = true, true
				return s
			},
		},
		{
			// The same step with Go's zero value left in place. x509 emits
			// pathLen:0 when MaxPathLen is 0 and MaxPathLenZero is set, and
			// nothing but a full-path validator ever notices — see the same trap
			// documented on max_path_length in terraform/pki/pki.tf.
			name:    "ceremony: mint anchors (pathLen 0 — the Go zero value)",
			enabled: func(s State, _ Params) bool { return !s.Minted },
			apply: func(s State, _ Params) State {
				s.Minted, s.PathLenOK = true, false
				return s
			},
		},
		{
			name:    "1password: preserve the superseded Intermediate item",
			enabled: func(s State, _ Params) bool { return !s.OldEscrow && s.OPAnchors == genOld },
			apply:   func(s State, _ Params) State { s.OldEscrow = true; return s },
		},
		{
			name: "1password: publish the new ca.crt and ca.key",
			enabled: func(s State, p Params) bool {
				if !s.Minted || s.OPAnchors == genNew {
					return false
				}
				// Overwriting the item's fields is the point of no return: the
				// old Intermediate key signs everything currently deployed and
				// there is no other copy. Rollback must not depend on 1Password
				// item history, the same rule terraform/pki/README.md sets for
				// the cluster CA escrow.
				return !p.Guarded || s.OldEscrow
			},
			apply: func(s State, _ Params) State { s.OPAnchors = genNew; return s },
		},
		{
			// Replaces exactly four tls_locally_signed_cert resources: both
			// cluster CAs and both SA signers. Every tls_private_key must show
			// no change.
			name:    "atlantis: apply terraform/pki",
			enabled: func(s State, _ Params) bool { return s.TFSigned != s.OPAnchors },
			apply:   func(s State, _ Params) State { s.TFSigned = s.OPAnchors; return s },
		},
		{
			name:    "mise run pki:verify",
			enabled: always,
			apply: func(s State, _ Params) State {
				s.Verified = s.PathLenOK && s.certsCoherent()
				return s
			},
		},
		{
			name: "git: merge terraform/pki/certs to main",
			enabled: func(s State, p Params) bool {
				if s.Committed {
					return false
				}
				// Hosts auto-upgrade from main. Merging an unverified chain
				// starts a clock the operator does not control.
				return !p.Guarded || s.Verified
			},
			apply: func(s State, _ Params) State { s.Committed = true; return s },
		},
		{
			name:    "flux: reconcile the spindrift CA bundle",
			enabled: func(s State, _ Params) bool { return s.Committed },
			apply: func(s State, _ Params) State {
				s.LiveBundleOffsiteCA = s.FileBundleOffsiteCA
				s.LiveBundleFollyChain = s.FileBundleFollyChain
				return s
			},
		},
		{
			name: "1password: destroy the superseded anchors",
			enabled: func(s State, p Params) bool {
				if s.OldBurned {
					return false
				}
				if !p.Guarded {
					return true
				}
				// Nothing may stop trusting the old anchors until every store
				// that has to verify something already holds the new ones.
				for c := range numClusters {
					if s.PodProc[c] != (chain{genNew, genNew, genNew}) ||
						s.KCMPub[c] != (chain{genNew, genNew, genNew}) ||
						s.ClosureCA[c] != genNew || s.Cfssl[c] != genNew {
						return false
					}
				}
				return s.LiveBundleFollyChain == chain{genNew, genNew, genNew} &&
					s.LiveBundleOffsiteCA == genNew
			},
			apply: func(s State, _ Params) State { s.OldBurned = true; s.OldEscrow = false; return s },
		},
	}

	for c := range numClusters {
		c := c
		as = append(as,
			action{
				// post-rotate.sh rewrites fml-root.pem and fml-intermediate.pem
				// unconditionally, then this cluster's CA, chain and JWKS, then
				// the spindrift bundle from whatever offsite-ca.pem and
				// folly-ca-chain.pem happen to be. Running it for one cluster
				// therefore moves the shared anchors and leaves the other
				// cluster's chain behind.
				name:    "scripts/pki/post-rotate.sh " + clusterName[c],
				enabled: always,
				apply: func(s State, _ Params) State {
					s.FileRoot, s.FileInt = s.OPAnchors, s.OPAnchors
					s.FileCA[c] = s.TFSigned
					s.FileChain[c] = chain{CA: s.FileCA[c], Int: s.FileInt, Root: s.FileRoot}
					// The SA signer key survives the re-birth, so the reissued
					// certificate carries the same public key and the script's
					// SPKI comparison writes no *-sa-signer-prev.pem. One entry,
					// one kid.
					s.JWKS[c] = 1
					s.FileBundleOffsiteCA = s.FileCA[offsite]
					s.FileBundleFollyChain = s.FileChain[folly]
					s.Committed, s.Verified = false, false
					return s
				},
			},
			action{
				// Hosts rebuild from main on their own auto-upgrade timer, so
				// this needs no operator. sops-nix compares decrypted plaintext
				// and the keys are unchanged, so nothing restarts: Cfssl and
				// KCMPub deliberately do not move here.
				name:    "nixos-rebuild " + clusterName[c],
				enabled: func(s State, _ Params) bool { return s.Committed },
				apply: func(s State, _ Params) State {
					s.ClosureCA[c] = s.FileCA[c]
					s.ClosureChain[c] = s.FileChain[c]
					return s
				},
			},
			action{
				name:    "systemctl restart cfssl (" + clusterName[c] + ")",
				enabled: func(s State, _ Params) bool { return s.Cfssl[c] != s.ClosureCA[c] },
				apply:   func(s State, _ Params) State { s.Cfssl[c] = s.ClosureCA[c]; return s },
			},
			action{
				name:    "systemctl restart kube-controller-manager (" + clusterName[c] + ")",
				enabled: func(s State, _ Params) bool { return s.KCMPub[c] != s.ClosureChain[c] },
				apply:   func(s State, _ Params) State { s.KCMPub[c] = s.ClosureChain[c]; return s },
			},
			action{
				name:    "kubelet: refresh projected ca.crt (" + clusterName[c] + ")",
				enabled: func(s State, _ Params) bool { return s.PodCA[c] != s.KCMPub[c] },
				apply:   func(s State, _ Params) State { s.PodCA[c] = s.KCMPub[c]; return s },
			},
			action{
				// NODE_EXTRA_CA_CERTS and Vector's CA file are read once at
				// process start, so a refreshed projection reaches nothing until
				// the pod restarts.
				name:    "kubectl rollout restart openssl clients (" + clusterName[c] + ")",
				enabled: func(s State, _ Params) bool { return s.PodProc[c] != s.PodCA[c] },
				apply:   func(s State, _ Params) State { s.PodProc[c] = s.PodCA[c]; return s },
			},
		)
	}

	if p.Guarded {
		return as
	}

	// The two wrong turns. Both are what a tired operator reaches for, and
	// neither is available in the sanctioned plan.
	for c := range numClusters {
		c := c
		as = append(as,
			action{
				// The 2am fix for "unable to get issuer certificate": put the
				// anchors where the failing client is already looking. caFile
				// also backs clientCaFile and kubeletClientCaFile.
				name:    "operator: merge the chain into " + clusterName[c] + "-ca-bundle.pem",
				enabled: func(s State, _ Params) bool { return !s.CAFilePoisoned[c] },
				apply:   func(s State, _ Params) State { s.CAFilePoisoned[c] = true; return s },
			},
			action{
				// Treating the reissue as a rotation: keep the previous signer
				// certificate for JWKS overlap. Its key is the same key, so the
				// second entry carries the same kid.
				name:    "operator: keep " + clusterName[c] + "-sa-signer-prev.pem for overlap",
				enabled: func(s State, _ Params) bool { return s.JWKS[c] == 1 },
				apply:   func(s State, _ Params) State { s.JWKS[c] = 2; return s },
			},
		)
	}
	return as
}

// certsCoherent is what pki:verify asserts about the committed files: every
// cluster CA is signed by the committed Intermediate, which is signed by the
// committed Root, and each chain file is the matching cluster CA followed by
// those two.
func (s State) certsCoherent() bool {
	if s.FileInt != s.FileRoot {
		return false
	}
	for c := range numClusters {
		if s.FileCA[c] != s.FileInt {
			return false
		}
		if s.FileChain[c] != (chain{CA: s.FileCA[c], Int: s.FileInt, Root: s.FileRoot}) {
			return false
		}
	}
	return true
}

// opensslUsable answers whether a client that builds a full path can verify an
// API server leaf against this store. Go clients cannot reach this predicate:
// crypto/x509 treats every certificate in a trust store as an anchor and stops
// there, which is exactly why the pathLen and linkage faults below stay
// invisible to kubectl, Flux and Prometheus.
func (s State) opensslUsable(store chain) bool {
	if !store.homogeneous() {
		return false
	}
	// A new-generation anchor that forbids the depth beneath it fails path
	// building for everyone at once, the moment it lands.
	return store.Root != genNew || s.PathLenOK
}

// violations lists every invariant this state breaks.
func (s State) violations(p Params) []string {
	var v []string
	for c := range numClusters {
		name := clusterName[c]

		// The chain must never become an authentication credential. caFile
		// backs clientCaFile and kubeletClientCaFile: a certificate carrying
		// O=system:masters issued anywhere under the FML Root would be
		// cluster-admin.
		if s.CAFilePoisoned[c] {
			v = append(v, name+": the FML anchors are in caFile, so anything issued under the FML Root authenticates to the API server")
		}

		// Duplicate JWKS kid.
		if s.JWKS[c] > 1 {
			v = append(v, fmt.Sprintf("%s: oidc/%s/jwks.json publishes %d entries for one signer key, so the same kid appears twice", name, name, s.JWKS[c]))
		}

		// Go clients verify the API server as long as the store holds a
		// certificate for the key cfssl is issuing under. The key survives the
		// re-birth, so this can only fire when the cluster CA key is rotated
		// too — which is the whole argument for not rotating it.
		if p.RotateClusterCAKey && s.ClosureCA[c] != s.Cfssl[c] {
			v = append(v, fmt.Sprintf("%s: caFile carries the %s cluster CA while cfssl issues under the %s one, so kubectl, Flux and Prometheus cannot verify the API server", name, s.ClosureCA[c], s.Cfssl[c]))
		}

		// OpenSSL clients inside the cluster: Vector, and anything else reading
		// ca.crt with a full-path validator.
		if !s.opensslUsable(s.PodProc[c]) {
			v = append(v, fmt.Sprintf("%s: pods hold ca.crt %s, which no full-path validator can build a path out of", name, s.PodProc[c]))
		}

		// kube-root-ca.crt itself, before any pod has picked it up.
		if !s.opensslUsable(s.KCMPub[c]) {
			v = append(v, fmt.Sprintf("%s: kube-root-ca.crt is %s", name, s.KCMPub[c]))
		}

		// The chain on disk, which the next KCM restart will publish.
		if !s.opensslUsable(s.ClosureChain[c]) {
			v = append(v, fmt.Sprintf("%s: --root-ca-file on disk is %s", name, s.ClosureChain[c]))
		}
	}

	// Spindrift reaches folly's API server over plain fetch with
	// NODE_EXTRA_CA_CERTS as its whole trust input, and the runtime does no
	// partial-chain verification: folly's three certificates have to agree.
	if !s.opensslUsable(s.LiveBundleFollyChain) {
		v = append(v, fmt.Sprintf("spindrift: the folly half of NODE_EXTRA_CA_CERTS is %s, so offsite cannot reach folly.lolwtf.ca:6443", s.LiveBundleFollyChain))
	}

	// Burning the old anchors while anything still needs them.
	if s.OldBurned {
		for c := range numClusters {
			if s.PodProc[c].Root == genOld || s.KCMPub[c].Root == genOld || s.ClosureChain[c].Root == genOld {
				v = append(v, clusterName[c]+": the superseded anchors are destroyed while pods, kube-root-ca.crt or --root-ca-file still name them")
			}
		}
		if s.LiveBundleFollyChain.Root == genOld {
			v = append(v, "spindrift: the superseded anchors are destroyed while NODE_EXTRA_CA_CERTS still names them")
		}
	}

	// The fleet auto-upgrades from main, so an unverified merge is a deployment.
	if s.Committed && !s.Verified {
		v = append(v, "terraform/pki/certs is on main without pki:verify having passed against it; hosts auto-upgrade from main on their own timer")
	}
	return v
}

// Initial is the estate before the ceremony: everything old, everything
// consistent, one JWKS entry per cluster.
func Initial() State {
	old := chain{genOld, genOld, genOld}
	s := State{FileBundleOffsiteCA: genOld, FileBundleFollyChain: old, LiveBundleOffsiteCA: genOld, LiveBundleFollyChain: old}
	for c := range numClusters {
		s.FileChain[c] = old
		s.ClosureChain[c] = old
		s.KCMPub[c] = old
		s.PodCA[c] = old
		s.PodProc[c] = old
		s.JWKS[c] = 1
	}
	return s
}

// Done is the state the cutover is trying to reach.
func (s State) Done() bool {
	if !s.OldBurned || !s.Verified || !s.Committed || s.OPAnchors != genNew || s.TFSigned != genNew {
		return false
	}
	all := chain{genNew, genNew, genNew}
	for c := range numClusters {
		if s.PodProc[c] != all || s.KCMPub[c] != all || s.ClosureChain[c] != all ||
			s.ClosureCA[c] != genNew || s.Cfssl[c] != genNew || s.JWKS[c] != 1 {
			return false
		}
	}
	return s.LiveBundleFollyChain == all && s.LiveBundleOffsiteCA == genNew
}

// Trace is a reachable sequence of steps and what it ends in.
type Trace struct {
	Steps      []string
	Violations []string
}

func (t Trace) String() string {
	out := ""
	for i, s := range t.Steps {
		out += fmt.Sprintf("  %2d. %s\n", i+1, s)
	}
	for _, v := range t.Violations {
		out += "  !! " + v + "\n"
	}
	return out
}

type node struct {
	parent *node
	step   string
}

func (n *node) steps() []string {
	var out []string
	for cur := n; cur != nil && cur.parent != nil; cur = cur.parent {
		out = append(out, cur.step)
	}
	slices.Reverse(out)
	return out
}

// Search explores every reachable interleaving breadth-first. It returns the
// shortest trace to each distinct violation (at most limit of them), whether a
// Done state is reachable, and how many states it visited.
func Search(p Params, limit int) (bad []Trace, doneReachable bool, visited int) {
	as := actions(p)
	seen := map[State]bool{Initial(): true}
	queue := []struct {
		s State
		n *node
	}{{Initial(), &node{}}}
	reported := map[string]bool{}

	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		visited++

		if v := cur.s.violations(p); len(v) > 0 {
			if !reported[v[0]] && len(bad) < limit {
				reported[v[0]] = true
				bad = append(bad, Trace{Steps: cur.n.steps(), Violations: v})
			}
			// A broken state is not a place to keep exploring from; the
			// operator is in a hole and the model has said so.
			continue
		}
		if cur.s.Done() {
			doneReachable = true
		}

		for _, a := range as {
			if !a.enabled(cur.s, p) {
				continue
			}
			next := a.apply(cur.s, p)
			if next == cur.s || seen[next] {
				continue
			}
			seen[next] = true
			queue = append(queue, struct {
				s State
				n *node
			}{next, &node{parent: cur.n, step: a.name}})
		}
	}
	return bad, doneReachable, visited
}

// RunbookPlan is the ordered sequence CUTOVER.md tells a human to follow. The
// tests replay it against the guarded model and assert that CUTOVER.md still
// lists these steps, in this order, so the runbook cannot drift away from the
// thing that was checked.
var RunbookPlan = []string{
	"ceremony: mint anchors (pathLen 2 / 1)",
	"1password: preserve the superseded Intermediate item",
	"1password: publish the new ca.crt and ca.key",
	"atlantis: apply terraform/pki",
	"scripts/pki/post-rotate.sh folly",
	"scripts/pki/post-rotate.sh offsite",
	"mise run pki:verify",
	"git: merge terraform/pki/certs to main",
	"flux: reconcile the spindrift CA bundle",
	"nixos-rebuild offsite",
	"systemctl restart cfssl (offsite)",
	"systemctl restart kube-controller-manager (offsite)",
	"kubelet: refresh projected ca.crt (offsite)",
	"kubectl rollout restart openssl clients (offsite)",
	"nixos-rebuild folly",
	"systemctl restart cfssl (folly)",
	"systemctl restart kube-controller-manager (folly)",
	"kubelet: refresh projected ca.crt (folly)",
	"kubectl rollout restart openssl clients (folly)",
	"1password: destroy the superseded anchors",
}

// Replay walks plan through the model, returning the state after each step and
// the first step that was not enabled or that broke an invariant.
func Replay(p Params, plan []string) (states []State, err error) {
	as := actions(p)
	s := Initial()
	states = append(states, s)
	for i, want := range plan {
		idx := slices.IndexFunc(as, func(a action) bool { return a.name == want })
		if idx < 0 {
			return states, fmt.Errorf("step %d: no action named %q", i+1, want)
		}
		if !as[idx].enabled(s, p) {
			return states, fmt.Errorf("step %d %q: not enabled", i+1, want)
		}
		s = as[idx].apply(s, p)
		states = append(states, s)
		if v := s.violations(p); len(v) > 0 {
			return states, fmt.Errorf("step %d %q: %v", i+1, want, v)
		}
	}
	return states, nil
}
