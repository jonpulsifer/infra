---
title: Build host and cache
description: How GitHub Actions builds NixOS closures and images, the Nix binary caches that hosts pull from, and the arm64 build role of forge.
---

GitHub Actions builds the NixOS closures and images of the lab, and the `jonpulsifer` Cachix cache stores what a merge to `main` produces. A host pulls store paths from Cachix when it deploys, so a deploy needs no build host. [forge](../../hosts/forge.md), a Raspberry Pi 5, keeps the build host role, which lets other machines run arm64 builds on it.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `nix-ci` workflow | Evaluates the fleet on a pull request, and on a merge to `main` builds the hosts and images that its jobs list | GitHub Actions |
| `nix-image-builder` workflow | Builds one image that you pick | GitHub Actions |
| `nixos-deploy` workflow | Builds a host on a native arm64 runner, and deploys a Pi 4 host over Tailscale | GitHub Actions |
| `jonpulsifer` Cachix cache | Holds the builds that CI pushes from `main` | Cachix |
| Build host role (`services.buildHost`) | Lets other machines run Nix builds on forge over SSH, four jobs at a time | forge |
| Docker and buildx | Build native arm64 OCI images | forge |
| harmonia | Serves forge's Nix store as a binary cache, signed with forge's cache key, on localhost port 5000 | forge |
| nginx | Proxies `forge.lolwtf.ca` on port 80 of forge's lab address to harmonia | forge |

## Pi Zero cross-build

The [Pi Zero W hosts](../../hosts/index.md) are armv6l. No armv6l binary cache exists, so their closures cross-compile from aarch64. `nix/hardware/pi0.nix` sets `nixpkgs.buildPlatform` to `aarch64-linux` and `nixpkgs.hostPlatform` to `raspberryPi`. The [registry](../nixos.md#registry), `nix/hosts/default.nix`, gives these hosts `system = "aarch64-linux"` and publishes their `sdImage` under `packages.aarch64-linux`. They build on the arm64 runner of `nixos-deploy` or `nix-image-builder`. No Pi Zero runs its NixOS config.

## Caches

Each host pulls from `jonpulsifer.cachix.org`, `nix-community.cachix.org` and `cache.nixos.org`, as `nix/system/nixos.nix` sets. The flake's `nixConfig` adds `nixos-raspberrypi.cachix.org` for builds that accept the flake's config, as CI does. Hosts do not list it.

forge's harmonia signs with `harmonia-cache-key` from `nix/secrets/forge.sops.yaml`, and its public key is `nix/secrets/forge-harmonia-cache.pub`. No host lists forge as a substituter. forge's firewall does not open TCP port 80, so the cache answers only on forge.

## Rules

- A pull request builds no host. The workflows push to Cachix only from `main`, so a deploy from a branch builds the changed store paths on the target.
- To use forge's cache, a host needs the cache URL in `substituters`, the public key in `trusted-public-keys`, and TCP port 80 open on forge.
- To build on forge from your machine, set `NIX_REMOTE=ssh-ng://forge.lolwtf.ca`. The build needs a Nix trusted user, and `nix/system/nixos.nix` makes `jawn` one.
- Keep the Pi 5 and DesignWare modules disabled in the Pi Zero kernel config in `nix/hardware/pi0.nix`. Some of them do not link for armv6l, and the kernel build fails.

## Where it lives

- `.github/workflows/nix-ci.yaml`, `nix-image-builder.yaml` and `nixos-deploy.yaml`: the CI builds
- `nix/services/build-host.nix`: the build host role and harmonia
- `nix/hosts/forge.nix`: the cache key, the nginx proxy and the Tailscale enrolment
- `nix/hardware/pi0.nix` and `nix/profiles/pi-zero.nix`: the Pi Zero cross-build

## Related

- [NixOS](../nixos.md)
- [Netboot](netboot.md)
- [Manage SOPS secrets](../../runbooks/manage-sops-secrets.md)
