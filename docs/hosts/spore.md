---
title: spore
description: A Raspberry Pi 5 on NVMe that serves x86 netboot, forge's HTTP boot image, the Talos boot image and Tinkerbell, lab DNS and time, and the SPIRE server.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
  serial: d860ec5f943fe335
  revision: d04171
  cpu: BCM2712, Cortex-A76 (4c)
  ram: 8 GB LPDDR4X-4267
  gpu: Broadcom VideoCore VII
  storage: "128 GB Patriot P300 NVMe (32 GB root, the rest at /nfs/data)"
  os: NixOS 26.05 (Yarara)
---

spore is a Raspberry Pi 5 that serves x86 netboot, forge's boot image, and lab DNS and time. It is on [the Anchor network](../platform/network.md#networks), folly's network for lab hosts.

## What it runs

`nix/hosts/spore.nix` imports these modules from `nix/services/`. `clusters/folly/monitoring/spore.yaml` declares their alerts.

- The `/nfs/data` filesystem, which holds Garage, the rackpi5 boot images and an export to the Lab future network (`nfs-server.nix`). No Kubernetes volume lives on it.
- [Netboot](../platform/nixos/netboot.md) for x86 PXE and [rackpi5](rackpi5.md) (`pxe-netboot.nix`, `spore-native-boot.nix`)
- [Tinkerbell](../platform/nixos/tinkerbell.md), which answers PXE on the bootstrap VLAN and reprovisions folly's Talos nodes (`tinkerbell.nix`)
- [Lab DNS and time](../platform/network/ingress-and-dns.md#lab-dns-and-time) and [Talos boot](../platform/nixos/talos-boot.md) on the bootstrap VLAN (`nix/profiles/anchor.nix`, which imports `coredns-sinkhole.nix`, `ntp-server.nix` and `talos-boot.nix`)
- folly's [backup](../platform/backups.md) Garage store, with data in `/nfs/data/garage-ha` (`garage.nix`), as a node of the [Garage cluster](../platform/backups.md#garage-cluster). The old standalone store in `/nfs/data/garage` is the rollback.
- The [SPIRE server](../platform/identity.md) that attests Talos nodes by TPM (`spire-server.nix`)

## Reach

Reach it at `spore.lolwtf.ca` or [`spore.<tailnet>`](index.md#reach-a-host).

## Quirks

- `nix.gc` keeps 7 days and the system profile keeps the current generation and 3 before it, because each generation adds a boot image to the 32 GB root. The rackpi5 publisher keeps the newest 4 releases.
