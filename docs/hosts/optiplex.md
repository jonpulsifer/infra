---
title: optiplex
description: A Dell OptiPlex 3050 micro that is the folly cluster's only control-plane node, on Talos Linux.
specs:
  vendor: Dell
  model: OptiPlex 3050 (micro)
  serial: 66BT7M2
  sku: 07A3
  cpu: "Intel Core i7-7700T @ 2.90GHz (4c/8t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 630
  storage: 256 GB SK hynix SC311 SATA SSD
  os: Talos Linux 1.14
  firmware: BIOS 1.27.0
  tpm: Nuvoton TPM 2.0 with EK certificates in NV; the running node has no /dev/tpmrm0, so tpm_off in clusters/folly/talos/nodes.tf treats it as off
  boot: Image Factory systemd-boot UKI, Secure Boot off
  disks: plain; a signed install seals them to the TPM after tpm_off drops optiplex
---

optiplex is the only control-plane node of the folly [Kubernetes](../platform/kubernetes.md) cluster. It runs [Talos Linux](../platform/kubernetes/talos.md), and `clusters/folly/talos/` configures it.

## What it runs

- etcd, the API server, the controller manager and the scheduler
- Pods, because the control plane has no taint

The cluster CA and the token signer key are in the secrets bundle, the 1Password item `talos-folly-secrets`. See [PKI](../platform/pki.md).

## Reach

Reach it at `optiplex.lolwtf.ca` with `talosctl --context folly`, as [Issue a talosconfig](../runbooks/issue-a-talosconfig.md) says. It runs no SSH server.

## Quirks

- One SATA SSD holds the ETCD partition, the EPHEMERAL partition and the `data` volume at `/var/mnt/data`. When it saturates, etcd slows and `EtcdRequestsSlow` in `clusters/base/monitoring/etcd-rules.yaml` fires.
- When optiplex reboots, the folly API stops.
