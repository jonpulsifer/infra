icon:: 🏡

- # jonpulsifer/infra
- The living documentation for a multi-layer homelab managed entirely as code: NixOS bare metal, two Kubernetes clusters, Terraform-managed cloud and network fabric, and GitOps-driven deployments. The source of truth is the [infra repository](https://github.com/jonpulsifer/infra); this wiki is the `docs/` Logseq graph inside it, published on every merge to `main`.
- ## Start here
	- [[Architecture]] — the four layers and how they fit together
	- [[ADR]] — architecture decision records: why things are the way they are
	- [[Runbooks]] — operational procedures for when things misbehave
	- [[Fleet]] — every host, its role, and its hardware
	- [[Contributing]] — how to edit this wiki
- ## The stack in one breath
	- **Layer 1 — Bare metal**: [[Architecture/NixOS]] configurations for every physical host, deployed with `nixos-rebuild` and kept honest by auto-upgrades from `main`.
	- **Layer 2 — Kubernetes**: two clusters (`folly` on-site, `offsite` backup) reconciled by FluxCD, described in [[Architecture/Kubernetes]].
	- **Layer 3 — Cloud & network**: UniFi, Cloudflare, Tailscale, GCP, and Google Workspace, all under [[Architecture/Terraform]] with applies gated through Atlantis. OpenBao runs through Flux in the folly cluster.
	- **Layer 4 — Applications**: first-party services, packages, and OCI images, catalogued in [[Architecture/Applications]].
	- Everything ships the same way: open a PR, let the operators apply it. See [[Architecture/GitOps]].
- ## House rules
	- Author desired state in git; never mutate live infra directly.
	- Network facts come from the `cluster-topology` single source of truth — see [[ADR/0003 Cluster topology single source of truth]].
	- Secrets are SOPS-encrypted in-repo; this wiki is public, so nothing decrypted ever lands here. See [[Architecture/Secrets and PKI]].
