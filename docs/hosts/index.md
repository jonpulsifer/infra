---
title: Hosts
description: "Every host in the homelab: Kubernetes nodes, Raspberry Pis, a microcontroller and a cloud VM, with their hardware."
---

Every host in the homelab. Each has a page under `hosts/` carrying its hardware sheet — vendor, model, serial, CPU, RAM, storage, firmware — and its physical quirks.

Roles, cluster membership, and node addresses are **not** recorded here. Hosts are declared in `flake.nix`; network facts live in the topology SSOT described on [Kubernetes](../platform/kubernetes.md). Read those.

## Kubernetes nodes

Declared in `nix/hosts/`. See [Kubernetes](../platform/kubernetes.md) for cluster composition.

| Host | Cluster | Hardware |
| ---- | ------- | -------- |
| [optiplex](optiplex.md) | folly | Dell OptiPlex 3050 micro, i7-7700T |
| [riptide](riptide.md) | folly | HP EliteDesk 800 G5 DM, i5-9500T |
| [shale](shale.md) | folly | HP EliteDesk 800 G2 DM 35W, i7-6700T |
| [retrofit](retrofit.md) | offsite | HP EliteDesk 800 G2 DM 65W, i7-6700T |
| [oldschool](oldschool.md) | offsite | HP EliteDesk 800 G3 DM 35W, i5-6500 |

TPM across the x86 fleet: only [riptide](riptide.md) has an operational TPM 2.0; [shale](shale.md) and [retrofit](retrofit.md) enumerate TPM 1.2 (too old for `systemd-cryptenroll`); [optiplex](optiplex.md) needs BIOS enablement; [oldschool](oldschool.md) has none. Per-host detail is on each page.

## Raspberry Pis

Configured in `nix/hosts/`. See [NixOS](../platform/nixos.md) for how they build.

| Host | Purpose | Hardware |
| ---- | ------- | -------- |
| [spore](spore.md) | NFS, PXE, signed native-boot, DNS and NTP | Pi 5 8 GB, NVMe |
| [capsule](capsule.md) | DNS sinkhole and NTP | Pi 5 8 GB, NVMe |
| [forge](forge.md) | arm64 build host, harmonia cache, OCI builder | Pi 5 8 GB, NVMe |
| [homepi4](homepi4.md) | kiosk | Pi 4B 8 GB, 7" touch display |
| [weatherpi4](weatherpi4.md) | weather kiosk | Pi 4B 8 GB |
| [cloudpi4](cloudpi4.md) | utility and CoreDNS canary | Pi 4B 4 GB |
| [radiopi0](radiopi0.md) | radio | Pi Zero W |
| [blinkypi0](blinkypi0.md) | LED display | Pi Zero W |

No Pi in the fleet has TPM hardware; the SBC class does not expose one.

## Microcontroller

| Host | Purpose | Hardware |
| ---- | ------- | -------- |
| [eviropico](eviropico.md) | environment sensor | Pi Pico W, Pimoroni Enviro+ |

## Cloud

| Host | Where | Hardware |
| ---- | ----- | -------- |
| [oldboy](oldboy.md) | GCE, `homelab-ng` project | e2-micro, free tier |

When provisioned, its `shielded_instance_config` gives [oldboy](oldboy.md) a GCE vTPM; see the divergence below.

## Reaching hosts

LAN hosts resolve as `<host>.lolwtf.ca`.

[weatherpi4](weatherpi4.md) and the offsite nodes require the tailnet.

Kubernetes nodes have Tailscale disabled — reach them over the LAN or through the cluster.

## Known divergence

Git is the source of truth for this fleet; these hosts differ from what the repo declares, and each difference is a bug to close.

[cloudpi4](cloudpi4.md) runs Ubuntu. Its NixOS config exists and is unapplied.

[radiopi0](radiopi0.md) runs Raspbian. Its NixOS config carries no radio service; the armv6l closure builds but the service is not ported.

[blinkypi0](blinkypi0.md) is unplugged. Its NixOS config carries no device service and its device code is not in git.

[eviropico](eviropico.md) is unplugged. Its MicroPython code is not in git.

[oldboy](oldboy.md) is not provisioned. Its Terraform and NixOS config exist but no live instance runs; needs to be brought back.
