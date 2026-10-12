---
title: hotrod
description: An HP mini PC that is declared as an offsite worker node, on Talos Linux, and joins when the offsite root names it.
specs:
  vendor: HP
  cpu: "Intel Core i5-10500T"
  ram: 16 GB
  storage: 238 GB Samsung NVMe (/dev/nvme0n1)
  os: Talos Linux 1.14
  firmware: UEFI
---

hotrod is a worker node for the offsite [Kubernetes](../platform/kubernetes.md) cluster. It will run Talos Linux.

## What it runs

`NODE_ADDRESSES` in `clusters/offsite/config/cluster-topology.json` declares hotrod, and `clusters/offsite/talos/talos.tf` does not name it yet. It joins the cluster when that root names it. Until then it runs no workload.

## Reach

Its name is `hotrod.lolwtf.ca`. Once it runs Talos, reach it with `talosctl --context offsite --nodes hotrod.lolwtf.ca`. It will run no SSH server. [Install Talos on a node](../runbooks/install-talos-on-a-node.md) has the steps.
