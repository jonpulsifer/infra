icon:: 🏗️
tags:: architecture

- The homelab is four layers, each managed as code in the [infra repo](https://github.com/jonpulsifer/infra), each with its own apply mechanism. Changes flow downward rarely; most day-to-day work happens in one layer at a time.
- ## The four layers
	- ### Layer 1 — Bare metal ([[Architecture/NixOS]])
		- NixOS configurations under `nix/` for every physical host: Kubernetes nodes, Raspberry Pis, and a GCE VM. Declared in `flake.nix`, deployed with `nixos-rebuild`, self-healing via auto-upgrades that track `main`.
	- ### Layer 2 — Kubernetes ([[Architecture/Kubernetes]])
		- Two clusters under `clusters/`: `folly` (primary, on-site) and `offsite` (backup), plus `clusters/base/` for shared resources. FluxCD reconciles manifests on merge; ArgoCD handles apps sourced from external repos.
	- ### Layer 3 — Cloud & network ([[Architecture/Terraform]])
		- Terraform root modules under `terraform/`: UniFi network fabric, Cloudflare DNS/tunnels, Tailscale, GCP organization and projects, Google Workspace, and Vault. Applies run through Atlantis on the PR — see [[ADR/0001 GitOps apply model]].
	- ### Layer 4 — Applications ([[Architecture/Applications]])
		- First-party code: deployable services in `apps/`, reusable packages and Helm charts in `packages/`, base/tool OCI images in `images/`. Built by CI on change.
- ## Cross-cutting concerns
	- [[Architecture/Networking]] — VLANs, BGP, Cilium load balancing, tunnels, and the cross-site fabric
	- [[Architecture/Secrets and PKI]] — SOPS/age, Vault, and the offline root CA
	- [[Architecture/GitOps]] — how a change actually ships, layer by layer
	- [[Fleet]] — the concrete hosts all of this runs on
- ## Design principles
	- **GitOps-first.** Desired state lives in git; operators (Atlantis, Flux, ArgoCD, nixos auto-upgrade) apply it. Manual mutation of live infra is a bug, and out-of-band deploys get reverted by the machinery itself.
	- **Single source of truth for network facts.** Cluster IPs, CIDRs, ASNs, and API endpoints live in per-cluster `cluster-topology` ConfigMaps consumed by Flux, Nix, and Terraform alike — [[ADR/0003 Cluster topology single source of truth]].
	- **Decisions are recorded.** Anything with lasting consequences gets an [[ADR]].
