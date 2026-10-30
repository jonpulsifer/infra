---
title: capsule
description: A Raspberry Pi 5 on NVMe that is one of the three lab DNS and time anchors, and runs NetBox.
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

capsule is a Raspberry Pi 5 on [the Anchor network](../platform/network.md#networks), folly's network for lab hosts. With [spore](spore.md) and [forge](forge.md), it serves [Lab DNS and time](../platform/network/ingress-and-dns.md#lab-dns-and-time). `nix/hosts/capsule.nix` configures it.

## What it runs

- CoreDNS from `nix/services/coredns-sinkhole.nix` and chrony from `nix/services/ntp-server.nix`, both through `nix/profiles/anchor.nix`
- A node of folly's [Garage cluster](../platform/backups.md#garage-cluster), with data in `/var/lib/garage` (`nix/services/garage.nix`)
- [Talos boot](../platform/nixos/talos-boot.md) and [talos-attest](../apps/talos-attest.md) on the bootstrap VLAN, also through the anchor profile
- [NetBox](../platform/netbox.md), with its PostgreSQL and Redis, on the tailnet only (`nix/services/netbox.nix`), and its hourly drift check of folly's nodes (`nix/services/netbox-drift.nix`)

`clusters/folly/monitoring/capsule.yaml` declares the alerts `CapsuleCoreDnsDown`, `CapsuleChronyDown`, and those of [NetBox](../platform/netbox.md#operate).

## Reach

Reach it at `capsule.lolwtf.ca` or [`capsule.<tailnet>`](index.md#reach-a-host).

Rowbutt's sandboxes on offsite reach the Anchor network hosts with capsule as their ssh jump host. offsite's Kubernetes ranges reach the Anchor network only on capsule's ports 22 and 8080. See [Routing and firewall](../platform/network/routing-and-firewall.md).

## Quirks

- `nix/hosts/capsule.nix` forces the file system labels `NIXOS_DNS` and `FW_DNS`, which the NVMe carries. If they change, the host does not find its root and firmware partitions at boot.
