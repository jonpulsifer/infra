---
title: riptide
description: An HP EliteDesk 800 G5 mini PC that is a folly worker node with an Intel GPU, on Talos Linux.
specs:
  vendor: HP
  model: EliteDesk 800 G5 Desktop Mini
  serial: MXL0172Q6L
  sku: "9GB06UC#ABA"
  cpu: "Intel Core i5-9500T @ 2.20GHz (6c/6t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel UHD Graphics 630
  storage: 256 GB KIOXIA KXG60ZNV256G NVMe
  os: Talos Linux 1.14
  firmware: R21 Ver. 02.20.00
  tpm: TPM 2.0 (Infineon), working
---

riptide is a worker node in the folly [Kubernetes](../platform/kubernetes.md) cluster with an Intel GPU for pods. It runs Talos Linux, and `clusters/folly/talos/` configures it.

## What it runs

- Pods. `jellyfin` claims the Intel GPU as `gpu.intel.com/i915`. The `i915` system extension in the cluster's Image Factory schematic carries the driver.

## Reach

Reach it at `riptide.lolwtf.ca` with `talosctl --context folly --nodes riptide.lolwtf.ca`. It runs no SSH server.

## Quirks

- The `data` volume at `/var/mnt/data` holds jellyfin's media and the `local-path` volumes on riptide.
- The Intel GPU plugin in `clusters/folly/nodes/` makes no `/dev/dri/by-path` links. A dangling link there fails each pod that claims the GPU with `CreateContainerError`.
