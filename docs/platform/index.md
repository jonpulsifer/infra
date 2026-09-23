---
title: Platform
description: "The homelab's four layers (NixOS, Kubernetes, OpenTofu and first-party code), each managed as code with its own apply path."
---

The homelab is four layers, each managed as code in the [infra repo](https://github.com/jonpulsifer/infra), each with its own apply mechanism. Most day-to-day work happens in one layer at a time.

## The four layers

### Layer 1 — Bare metal ([NixOS](nixos.md))

NixOS configuration under `nix/` for every host. Declared in `flake.nix`, deployed with `nixos-rebuild`, self-healing via auto-upgrades that track `main`.

### Layer 2 — Kubernetes ([Kubernetes](kubernetes.md))

Two fully capable clusters under `clusters/`: `folly` on-site and `offsite` at the remote site, with `clusters/base/` shared between them. FluxCD reconciles every manifest on merge. ArgoCD is installed as a Flux HelmRelease and currently owns no applications.

- What runs on each cluster: [Workloads](workloads.md)

### Layer 3 — Cloud and network ([OpenTofu and Atlantis](opentofu.md))

OpenTofu root modules under `terraform/`, covering the network fabric and the cloud and identity estate. Applies run through Atlantis on the PR.

### Layer 4 — Applications ([Build and release](build-and-release.md))

First-party code: deployable services in `apps/`, reusable packages and Helm charts in `packages/`, base and tool OCI images in `images/`.

## Cross-cutting

- [Network](network.md) — VLANs, BGP, Cilium load balancing, tunnels, and the cross-site fabric
- [Secrets and PKI](secrets-and-pki.md) — SOPS/age, OpenBao, and the cluster CAs
- [How changes ship](how-changes-ship.md) — how a change actually ships, layer by layer
- [Built apps](../apps/kthx/built-apps.md) — the deploy control plane and its explicit runtime ownership boundary
- [Bosun](../apps/bosun.md) — ephemeral microVM runners for CI, and the warm pool that keeps them ready
- [kthx](../apps/kthx.md) — quick sites with a database, a socket and a visitor identity, at `<name>.kthx.dev`
- [Hosts](../hosts/index.md) — the concrete hosts all of this runs on

## Design principles

**GitOps-first.** Desired state lives in git; the operators — Atlantis, Flux, and NixOS auto-upgrade — apply it. Mutating live infrastructure by hand is a bug, and out-of-band changes get reverted by the machinery itself.

**Network facts have one source.** Cluster IPs, CIDRs, ASNs, and API endpoints live in the per-cluster `cluster-topology` ConfigMaps, read by Flux, Nix, and OpenTofu alike. A conftest contract enforces the schema in CI.

**Point, don't restate.** Documentation names the directory and lets the tree answer. A list written in prose is a list that goes stale.
