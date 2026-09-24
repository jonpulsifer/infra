---
title: Platform
description: The shared systems that the apps and hosts depend on, and what applies each layer from git.
cards: platform
---

The platform is the shared systems that the apps and hosts depend on. Git declares each layer, and a controller or workflow applies it, as [How changes ship](how-changes-ship.md) describes.

| Layer | Path | Applied by | Page |
| --- | --- | --- | --- |
| Hosts | `nix/` | The host's daily auto-upgrade, or `nixos-rebuild` | [NixOS](nixos.md) |
| Kubernetes | `clusters/` | Flux in each cluster | [Kubernetes](kubernetes.md) |
| Network, cloud accounts and cluster bootstrap | `terraform/` and `clusters/<site>/bootstrap/` | Atlantis, on a pull request comment | [OpenTofu and Atlantis](opentofu.md) |
| First-party code and images | `apps/`, `packages/` and `images/` | GitHub Actions, then Flux | [Build and release](build-and-release.md) |

## Pages
