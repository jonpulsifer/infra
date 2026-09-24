---
title: capsule
description: A Raspberry Pi 5 on NVMe that is one of the two lab DNS resolvers and time servers.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
  serial: d9c81ac9b4823886
  revision: d04171
  cpu: BCM2712, Cortex-A76 (4c)
  ram: 8 GB LPDDR4X-4267
  gpu: Broadcom VideoCore VII
  storage: 256 GB Patriot P300 NVMe
  os: NixOS 26.05 (Yarara)
---

capsule is a Raspberry Pi 5 on [Lab Net](../platform/network.md#networks), folly's network for lab hosts. With [spore](spore.md), it serves [Lab DNS and time](../platform/network/ingress-and-dns.md#lab-dns-and-time). `nix/hosts/capsule.nix` configures it.

## What it runs

- CoreDNS from `nix/services/coredns-sinkhole.nix`
- chrony from `nix/services/ntp-server.nix`

`clusters/folly/monitoring/capsule.yaml` declares the alerts `CapsuleCoreDnsDown` and `CapsuleChronyDown`.

## Reach

Reach it at `capsule.lolwtf.ca` or [`capsule.<tailnet>`](index.md#reach-a-host).

## Quirks

- `nix/hosts/capsule.nix` forces the file system labels `NIXOS_DNS` and `FW_DNS`, which the NVMe carries. If they change, the host does not find its root and firmware partitions at boot.
