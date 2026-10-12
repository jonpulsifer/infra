---
title: hotrod
description: An HP mini PC that is the offsite cluster's second worker node, on Talos Linux.
specs:
  vendor: HP
  cpu: "Intel Core i5-10500T"
  ram: 16 GB
  storage: 238 GB Samsung NVMe (/dev/nvme0n1)
  os: Talos Linux 1.14
  firmware: UEFI
---

hotrod is a worker node of the offsite [Kubernetes](../platform/kubernetes.md) cluster. It runs Talos Linux, and `clusters/offsite/talos/` configures it.

## What it runs

- Pods. `/var/mnt/data`, its `data` volume, holds the `local-path` volumes that land on hotrod.

## Reach

Reach it at `hotrod.lolwtf.ca` with `talosctl --context offsite`, as [Issue a talosconfig](../runbooks/issue-a-talosconfig.md) says. It runs no SSH server.

## Quirks

- The NVMe holds the EPHEMERAL partition and the `data` volume; there is no second disk.
