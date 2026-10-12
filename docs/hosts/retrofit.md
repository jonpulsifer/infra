---
title: retrofit
description: An HP EliteDesk 800 G2 mini PC that is the offsite cluster's only control-plane node, on Talos Linux.
specs:
  vendor: HP
  model: EliteDesk 800 G2 DM 65W
  serial: MXL7211HNN
  sku: "W3X40UC#ABA"
  cpu: "Intel Core i7-6700T @ 2.80GHz (4c/8t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 530
  storage: 512 GB Timetec SD08 SATA SSD
  os: Talos Linux 1.14
  firmware: N21 Ver. 02.21
  tpm: TPM 1.2, too old for systemd-cryptenroll
---

retrofit is the only control-plane node of the offsite [Kubernetes](../platform/kubernetes.md) cluster. It runs Talos Linux, and `clusters/offsite/talos/` configures it.

## What it runs

- etcd, the API server, the controller manager and the scheduler
- Pods, because the control plane has no taint

The cluster CA and the token signer key are in the secrets bundle, the 1Password item `talos-offsite-secrets`. See [PKI](../platform/pki.md).

## Reach

Reach it at `retrofit.lolwtf.ca` with `talosctl --context offsite`, as [Issue a talosconfig](../runbooks/issue-a-talosconfig.md) says. The API server answers at `offsite.lolwtf.ca`. It runs no SSH server.

## Quirks

- When retrofit reboots, the offsite API stops.
