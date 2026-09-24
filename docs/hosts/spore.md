---
title: spore
description: A Raspberry Pi 5 on NVMe that serves folly's NFS storage, x86 netboot, forge's HTTP boot image, and lab DNS and time.
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

spore is a Raspberry Pi 5 that serves NFS, x86 netboot, forge's boot image, and lab DNS and time. It is on [Lab Net](../platform/network.md#networks), folly's network for lab hosts.

## What it runs

`nix/hosts/spore.nix` imports these modules from `nix/services/`. `clusters/folly/monitoring/spore.yaml` declares their alerts.

- NFS for `clusters/folly/storage/` (`nfs-server.nix`)
- [Netboot](../platform/nixos/netboot.md) for x86 PXE and [rackpi5](rackpi5.md) (`pxe-netboot.nix`, `spore-native-boot.nix`)
- [Lab DNS and time](../platform/network/ingress-and-dns.md#lab-dns-and-time) (`coredns-sinkhole.nix`, `ntp-server.nix`)

## Reach

Reach it at `spore.lolwtf.ca` or [`spore.<tailnet>`](index.md#reach-a-host).

## Quirks

- Nix does not build the PXE files in `/var/lib/tftpboot`, and git declares no backup. `nix build .#netboot` rebuilds a rescue kernel and initrd.
- If NFS stops, pods that mount it hang and still read Ready.
- `nix.gc` keeps 7 days, because each generation adds a boot image to the 32 GB root.
