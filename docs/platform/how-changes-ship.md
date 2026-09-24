---
title: How changes ship
description: The path each kind of change takes from a pull request to the running system, and the GitOps rule that no one changes live state by hand.
---

Every change to the lab ships from git. A pull request (PR) declares the change, and a controller or a workflow applies it. The GitOps rule says that nobody changes live state by hand. The next apply overwrites a hand change or fails on it.

## Paths

| Change | Applied by | When |
| --- | --- | --- |
| An OpenTofu root under `terraform/` or `clusters/<site>/bootstrap/` | [Atlantis](opentofu.md), the server that applies OpenTofu from PRs | When someone comments `atlantis apply` on the PR. Atlantis then merges the PR. |
| A Kubernetes manifest under `clusters/` | Flux, the GitOps controller in each cluster | At the next sync of `main` after the merge |
| A NixOS host under `nix/` | The host's auto-upgrade, or `nixos-rebuild` | At the next daily [auto-upgrade](nixos.md#auto-upgrade) after the merge |
| A first-party image | `containers.yml`, then Flux | After the merge, the workflow builds the image and opens a PR that pins its digest. See [Build and release](build-and-release.md). |
| A wiki page under `docs/` | `wiki.yml` | On merge, to Cloudflare Pages. See [Wiki](../apps/wiki.md). |

## Kubernetes

The bootstrap root of each cluster is the OpenTofu root in `clusters/<site>/bootstrap/`. It installs `flux-operator` and a FluxInstance, the object that configures Flux. The FluxInstance syncs the `infra` GitRepository, Flux's copy of this repository, at `refs/heads/main`. It starts from the Flux Kustomizations in `clusters/<site>/flux-system/`, which name the paths that Flux applies.

folly syncs every hour, and offsite every five minutes. To sync a merge sooner, reconcile the `infra` GitRepository. A reconcile of a Flux Kustomization alone applies the revision that Flux already has.

Flux applies the manifests under `clusters/`. [kthx](../apps/kthx.md) owns the resources of each [App](../apps/kthx/built-apps.md) it deploys, and [who owns what](../apps/kthx/security.md#who-owns-what) states that boundary.

## NixOS

Auto-upgrade rebuilds a host from `main` each day. [NixOS](nixos.md#auto-upgrade) lists the hosts that have none. Those change only when someone deploys them with `nixos-rebuild` or the `nixos-deploy` workflow.

## Rules

- Do not run `kubectl apply` to change state. Use `kubectl`, `flux get` and `flux reconcile` to inspect or to force a sync.
- Do not run `tofu apply` on your machine. It takes the state lock from Atlantis and causes drift.
- Apply an OpenTofu PR before you merge it, as [OpenTofu and Atlantis](opentofu.md#rules) says.
- Merge a host change on the day you deploy it from a branch. The next auto-upgrade rebuilds the host from `main` and removes the change.

## Where it lives

- `clusters/<site>/bootstrap/flux-values.yaml`: `instance.sync`, the source, path and interval of the Flux sync. A change to it gets no autoplan, as [OpenTofu and Atlantis](opentofu.md#rules) says.
- `clusters/<site>/flux-system/`: the Flux Kustomizations of each cluster
- `nix/system/nixos.nix`: `system.autoUpgrade`
- `.github/workflows/nixos-deploy.yaml`: the deploy workflow for the Pi hosts

## Related

- [OpenTofu and Atlantis](opentofu.md)
- [Build and release](build-and-release.md)
- [Apply an OpenTofu change](../runbooks/apply-an-opentofu-change.md)
- [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md)
