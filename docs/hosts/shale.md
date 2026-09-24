---
title: shale
description: An HP EliteDesk 800 G2 mini PC that is a folly worker node.
specs:
  vendor: HP
  model: EliteDesk 800 G2 DM 35W
  serial: MXL6372537
  sku: "V0B22UP#ABA"
  cpu: "Intel Core i7-6700T @ 2.80GHz (4c/8t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 530
  storage: 512 GB KingFast SATA SSD
  os: NixOS 26.05 (Yarara)
  firmware: N21 Ver. 02.37
  tpm: TPM 1.2, too old for systemd-cryptenroll
---

shale is a worker node in the folly [Kubernetes](../platform/kubernetes.md) cluster. `nix/hosts/shale.nix` configures it.

## What it runs

shale runs pods.

## Reach

Reach it at `shale.lolwtf.ca`.
