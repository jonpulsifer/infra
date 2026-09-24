---
title: NixOS
description: The flake that builds each Linux host and OS image, the fleet baseline each host shares, and the daily upgrade from main.
---

Each Linux host in the lab runs NixOS, a Linux distribution that builds each system from Nix code. One flake builds every host, OS image and Nix-built package, and the registry, `nix/hosts/default.nix`, lists them.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Registry | Lists each host, image and package. `flake.nix` derives its outputs from it. | Evaluation |
| Fleet baseline | The modules each deployable host gets, in `nix/profiles/fleet.nix` | Each `host` entry |
| disko | Partitions and mounts the disk | Each Kubernetes node |
| sops-nix | Decrypts host secrets with the SSH host key | Hosts that import `nix/system/sops.nix` |
| [Netboot](nixos/netboot.md) | Serves x86 PXE boot and forge's signed RAM-boot image | spore |
| [Build host and cache](nixos/build-host-and-cache.md) | Arm64 builds and the Nix caches | forge and Cachix |

## Registry

The header of `nix/hosts/default.nix` defines each field. `kind` sets the default baseline, and `baseline` overrides it, as in `iso` and `netboot`.

| `kind` | Default baseline | Result |
| --- | --- | --- |
| `host` | Fleet baseline, `nix/profiles/fleet.nix` | A deployable system |
| `image` | Image baseline, `nix/profiles/base.nix` | A built image, such as `wsl` |
| `package` | None | A plain derivation, such as `asterisk-image` |

- A host turns off part of the fleet baseline with an explicit override, or with a `homelab.fleet.*` option that the image baseline declares.
- A Kubernetes node joins the cluster named in its registry `tags` field, `folly` or `offsite`.
- Kubernetes nodes turn Tailscale off with `nix/system/tailscale-disable.nix`. Reach them as `<host>.lolwtf.ca`.

## Auto-upgrade

A host with auto-upgrade rebuilds from `main` at 03:37 local time, up to an hour later at random, and switches without a reboot. A failed build keeps the running generation.

| Hosts | Auto-upgrade | Set in |
| --- | --- | --- |
| Pi 4 hosts (microSD root) | Off | `nix/hardware/pi4/default.nix` |
| Pi Zero hosts | Off | `nix/profiles/pi-zero.nix` |
| Every other host | On | `nix/system/nixos.nix` |

## Rules

- If you deploy a host change from a branch, merge it before the next auto-upgrade, or the upgrade removes it.
- Read addresses and names through `nix/services/k8s/networks.nix`, `nix/lib/lab.nix` and `nix/lib/fleet.nix`, which project the [topology files](../reference/topology.md). A copied value goes stale when the topology file changes.
- A Kubernetes node mounts its partitions by GPT name, such as `disk-main-nixos`, and does not boot without them. [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md#rename-the-partitions-of-a-kubernetes-node) renames them.

- A new host cannot decrypt its SOPS file until its SSH host key is a recipient, as [Manage SOPS secrets](../runbooks/manage-sops-secrets.md) describes.
- Run `mise run nix:check` before a PR. It evaluates each configuration and runs the fleet assertions in `nix/lib/checks.nix`, and a failure fails `nix-ci`.

## Where it lives

- `nix/hosts/`: the registry and one file per host
- `nix/profiles/`, `nix/hardware/`, `nix/system/` and `nix/services/`: baselines, board support, fleet modules and service modules
- `nix/images/`: image modules and the installer's `INSTALL.md`
- `nix/disko/default.nix`: `homelab.disko.device` and `homelab.disko.rootSize`
- `nix/scripts/disko-partlabel-check.sh` and `disko-partlabel-migrate.sh`: the partition name check and rename
- `.github/workflows/nix-ci.yaml`: the PR flake check and the builds on `main`

## Related

- [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md)
- [Add a Kubernetes node](../runbooks/add-a-kubernetes-node.md)
- [Test a change](../runbooks/test-a-change.md)
- [Secrets](secrets.md)
