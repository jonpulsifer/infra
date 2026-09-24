---
title: riptide
description: An HP EliteDesk 800 G5 mini PC that is a folly worker node with an Intel GPU and the build host for folly deploys.
specs:
  vendor: HP
  model: EliteDesk 800 G5 Desktop Mini
  serial: MXL0172Q6L
  sku: "9GB06UC#ABA"
  cpu: "Intel Core i5-9500T @ 2.20GHz (6c/6t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel UHD Graphics 630
  storage: 256 GB KIOXIA KXG60ZNV256G NVMe
  os: NixOS 26.05 (Yarara)
  firmware: R21 Ver. 02.20.00
  tpm: TPM 2.0 (Infineon), working
---

riptide is a worker node in the folly [Kubernetes](../platform/kubernetes.md) cluster with an Intel GPU for pods. It is also the build host for folly node deploys. `nix/hosts/riptide.nix` configures it.

## What it runs

- Pods. `jellyfin` claims the Intel GPU as `gpu.intel.com/i915`.
- The builds for folly node deploys. See [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md).

## Reach

Reach it at `riptide.lolwtf.ca`.

## Quirks

- The `prune-dri-by-path` unit removes dangling `/dev/dri/by-path` links before kubelet starts. Without it, each pod that claims the GPU fails with `CreateContainerError`.
- `/mnt/disks` holds jellyfin's media and the `local-path` volumes on riptide.
