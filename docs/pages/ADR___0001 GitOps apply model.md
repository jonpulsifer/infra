status:: accepted
date:: 2024 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- The homelab spans four layers with different tooling (Terraform, Kubernetes manifests, NixOS). Applying changes by hand from a laptop invites drift, races between operators, un-reviewed changes, and state/lock corruption. There should be exactly one way a change reaches production, and it should leave an audit trail.
- # Decision
	- Git is the source of truth; **operators apply, humans merge**:
		- **Terraform** applies only through **Atlantis** on the PR: autoplan on open, `atlantis apply` comment to apply, automerge on success. Local `terraform apply` against remote state is forbidden.
		- **Kubernetes** state applies only through **Flux** (and **ArgoCD** for external-repo apps) on merge to `main`. `kubectl apply` is never used to author state.
		- **NixOS** hosts auto-rebuild from GitHub `main`; `nixos-rebuild` remains the manual apply path but anything not merged reverts on the next upgrade cycle.
- # Consequences
	- Every production change has a PR, a plan/diff, and a reviewer (even if that reviewer is future-you).
	- Lock contention and state races disappear — Atlantis is the only writer.
	- Local workflows become inspection-only (`terraform init -backend=false && validate`, `flux get`, `kubectl get`), which also means CI and web sessions need no production credentials.
	- Emergency fixes are slower by one PR; that is the accepted cost.
	- Bootstrap remains a chicken-and-egg exception: `clusters/<site>/bootstrap/` Terraform installs Flux itself.
- # Links
	- [[Architecture/GitOps]], [[Architecture/Terraform]], [[Architecture/Kubernetes]]
