---
title: optiplex
description: A Dell OptiPlex 3050 micro that is the folly cluster's only control-plane node and runs its cluster CA.
specs:
  vendor: Dell
  model: OptiPlex 3050 (micro)
  serial: 66BT7M2
  sku: 07A3
  cpu: "Intel Core i7-7700T @ 2.90GHz (4c/8t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 630
  storage: 256 GB SK hynix SC311 SATA SSD
  os: NixOS 26.05 (Yarara)
  firmware: BIOS 1.27.0
  tpm: Intel PTT, not enabled in the BIOS
---

optiplex is the only control-plane node of the folly [Kubernetes](../platform/kubernetes.md) cluster. `nix/hosts/optiplex.nix` configures it.

## What it runs

- etcd, the API server, the controller manager and the scheduler
- cfssl with the folly cluster CA. The CA key and the token signer key come from `nix/secrets/optiplex.sops.yaml`. See [PKI](../platform/pki.md).
- Pods, because the control plane has no taint

## Reach

Reach it at `optiplex.lolwtf.ca`.

## Quirks

- One SATA SSD holds etcd, the Nix store, containerd and the `local-path` volumes. When the disk saturates, etcd slows and many folly controllers restart together. `EtcdRequestsSlow` in `clusters/base/monitoring/etcd-rules.yaml` fires first.
- When optiplex reboots, the folly API stops.
