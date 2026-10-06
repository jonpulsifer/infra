---
title: shale
description: An HP EliteDesk 800 G2 mini PC that is a folly worker node, on Talos Linux.
specs:
  vendor: HP
  model: EliteDesk 800 G2 DM 35W
  serial: MXL6372537
  sku: "V0B22UP#ABA"
  cpu: "Intel Core i7-6700T @ 2.80GHz (4c/8t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 530
  storage: 512 GB KingFast SATA SSD
  os: Talos Linux 1.14
  firmware: N21 Ver. 02.37
  tpm: TPM 1.2, too old for systemd-cryptenroll
---

shale is a worker node in the folly [Kubernetes](../platform/kubernetes.md) cluster. It runs Talos Linux, and `clusters/folly/talos/` configures it.

## What it runs

shale runs pods. The `data` volume at `/var/mnt/data` holds the `local-path` volumes on shale.

## Reach

Reach it at `shale.lolwtf.ca` with `talosctl --context folly --nodes shale.lolwtf.ca`. It runs no SSH server.
