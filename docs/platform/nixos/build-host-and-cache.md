---
title: Build host and cache
description: Where NixOS closures build before a deploy, forge's arm64 build role, and the Nix binary caches that hosts pull from.
---

A build host is the machine that builds a NixOS closure before a deploy copies it to the target. Each deploy builds on the build host that [Deploy a NixOS host](../../runbooks/deploy-a-nixos-host.md) names for the target. [forge](../../hosts/forge.md), a Raspberry Pi 5, is the native arm64 build host for the Raspberry Pis, and it builds arm64 OCI images.

Each host pulls prebuilt store paths from Nix binary caches, mainly the `jonpulsifer` Cachix cache that CI fills from `main`. forge also runs its own cache, which no host uses.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Build host role (`services.buildHost`) | Lets other machines run Nix builds on forge over SSH, four jobs at a time | forge |
| Docker and buildx | Build native arm64 OCI images | forge |
| harmonia | Serves forge's Nix store as a binary cache, signed with forge's cache key, on localhost port 5000 | forge |
| nginx | Proxies `forge.lolwtf.ca` on port 80 of forge's lab address to harmonia | forge |
| `jonpulsifer` Cachix cache | Holds the builds that CI pushes from `main` | Cachix |
| `nixos-deploy` workflow | Builds a Pi 4 or Pi Zero host on a native arm64 runner, and deploys a Pi 4 host | GitHub Actions |

## Pi Zero cross-build

The [Pi Zero W hosts](../../hosts/index.md) are armv6l. No armv6l binary cache exists, so their closures cross-compile from aarch64. `nix/hardware/pi0.nix` sets `nixpkgs.buildPlatform` to `aarch64-linux` and `nixpkgs.hostPlatform` to `raspberryPi`. The [registry](../nixos.md#registry), `nix/hosts/default.nix`, gives these hosts `system = "aarch64-linux"` and publishes their `sdImage` under `packages.aarch64-linux`. They build on forge or on the `nixos-deploy` runner. No Pi Zero runs its NixOS config.

## Caches

Each host pulls from `jonpulsifer.cachix.org`, `nix-community.cachix.org` and `cache.nixos.org`, as `nix/system/nixos.nix` sets. The flake's `nixConfig` adds `nixos-raspberrypi.cachix.org` for builds that accept the flake's config, as CI does. Hosts do not list it.

forge's harmonia signs with `harmonia-cache-key` from `nix/secrets/forge.sops.yaml`, and its public key is `nix/secrets/forge-harmonia-cache.pub`. No host lists forge as a substituter. forge's firewall does not open TCP port 80, so the cache answers only on forge.

## Rules

- To use forge's cache, a host needs the cache URL in `substituters`, the public key in `trusted-public-keys`, and TCP port 80 open on forge.
- To build on forge from your machine, set `NIX_REMOTE=ssh-ng://forge.lolwtf.ca`, as [Test a change](../../runbooks/test-a-change.md) shows. The build needs a Nix trusted user, and `nix/system/nixos.nix` makes `jawn` one.
- Keep the Pi 5 and DesignWare modules disabled in the Pi Zero kernel config in `nix/hardware/pi0.nix`. Some of them do not link for armv6l, and the kernel build fails.

## Where it lives

- `nix/services/build-host.nix`: the build host role and harmonia
- `nix/hosts/forge.nix`: the cache key, the nginx proxy and the Tailscale enrolment
- `nix/hardware/pi0.nix` and `nix/profiles/pi-zero.nix`: the Pi Zero cross-build
- `.github/workflows/nixos-deploy.yaml`, `nix-ci.yaml` and `nix-image-builder.yaml`: the CI builds

## Related

- [NixOS](../nixos.md)
- [Netboot](netboot.md)
- [Manage SOPS secrets](../../runbooks/manage-sops-secrets.md)
