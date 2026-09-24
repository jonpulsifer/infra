---
title: retrofit
description: An HP EliteDesk 800 G2 mini PC that is the offsite cluster's only control-plane node and runs its cluster CA.
specs:
  vendor: HP
  model: EliteDesk 800 G2 DM 65W
  serial: MXL7211HNN
  sku: "W3X40UC#ABA"
  cpu: "Intel Core i7-6700T @ 2.80GHz (4c/8t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 530
  storage: 512 GB Timetec SD08 SATA SSD
  os: NixOS 26.05 (Yarara)
  firmware: N21 Ver. 02.21
  tpm: TPM 1.2, too old for systemd-cryptenroll
---

retrofit is the only control-plane node of the offsite [Kubernetes](../platform/kubernetes.md) cluster. `nix/hosts/retrofit.nix` configures it.

## What it runs

- etcd, the API server, the controller manager and the scheduler
- cfssl with the offsite cluster CA. The CA key and the token signer key come from `nix/secrets/retrofit.sops.yaml`. See [PKI](../platform/pki.md).
- Pods, because the control plane has no taint

## Reach

Reach it at `offsite.lolwtf.ca`, the offsite API server name, or at `retrofit.lolwtf.ca`. See [Reach a host](index.md#reach-a-host).

## Quirks

- When retrofit reboots, the offsite API stops.
