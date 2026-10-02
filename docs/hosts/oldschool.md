---
title: oldschool
description: An HP EliteDesk 800 G3 mini PC that is the offsite cluster's worker node.
specs:
  vendor: HP
  model: EliteDesk 800 G3 DM 35W
  serial: 8CG74769HJ
  sku: "1VR53UC#ABA"
  cpu: "Intel Core i5-6500 @ 3.20GHz (4c/4t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 530
  storage: "512 GB KingFast SATA SSD (200 GB root, the rest at /mnt/disks)"
  os: NixOS 26.05 (Yarara)
  firmware: P21 Ver. 02.15
  tpm: none
---

oldschool is the worker node of the offsite [Kubernetes](../platform/kubernetes.md) cluster. `nix/hosts/oldschool.nix` configures it.

## What it runs

- Pods. `/mnt/disks` holds the `local-path` volumes on oldschool, including the [kthx](../apps/kthx.md) sites volume. `KthxSitesDiskFilling` fires when it has less than 25% free.
- offsite's [backup](../platform/backups.md) Garage store, a StatefulSet in `clusters/offsite/garage/` on the host network, with data in `/mnt/disks/garage`.

## Reach

Reach it at `oldschool.lolwtf.ca`. See [Reach a host](index.md#reach-a-host).

## Quirks

- oldschool holds a `harmonia-cache-key` secret and a 200 GB root for [harmonia](../platform/nixos/build-host-and-cache.md), a Nix binary cache, which is not enabled.
