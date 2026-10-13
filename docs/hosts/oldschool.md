---
title: oldschool
description: An HP EliteDesk 800 G3 mini PC that is the offsite cluster's worker node, on Talos Linux.
specs:
  vendor: HP
  model: EliteDesk 800 G3 DM 35W
  serial: 8CG74769HJ
  sku: "1VR53UC#ABA"
  cpu: "Intel Core i5-6500 @ 3.20GHz (4c/4t)"
  ram: 16 GB DDR4 SODIMM
  gpu: Intel HD Graphics 530
  storage: 512 GB KingFast SATA SSD
  os: Talos Linux 1.14
  firmware: P21 Ver. 02.15
  tpm: none
---

oldschool is the worker node of the offsite [Kubernetes](../platform/kubernetes.md) cluster. It runs Talos Linux, and `clusters/offsite/talos/` configures it.

## What it runs

- Pods. The `data` volume at `/var/mnt/data` holds the `local-path` volumes on oldschool, including the [kthx](../apps/kthx.md) sites volume. `KthxSitesDiskFilling` fires when it has less than 25% free.
- offsite's [backup](../platform/backups.md) Garage store, a StatefulSet in `clusters/offsite/garage/` on the host network, with data in `/var/mnt/data/garage`.

## Reach

Reach it at `oldschool.lolwtf.ca` with `talosctl --context offsite --nodes oldschool.lolwtf.ca`. It runs no SSH server.

## Quirks

- A JetKVM gives its console video and keyboard. The kernel lists it as the USB device `JetKVM USB Emulation Device`. See [Unmanaged devices at offsite](index.md#unmanaged-devices-at-offsite).
