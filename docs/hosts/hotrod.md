---
title: hotrod
description: An HP mini PC that is the offsite cluster's sandbox node, the worker that runs the untrusted work, on Talos Linux.
specs:
  vendor: HP
  cpu: "Intel Core i5-10500T"
  ram: 16 GB
  storage: 238 GB Samsung NVMe (/dev/nvme0n1)
  os: Talos Linux 1.14
  firmware: UEFI
---

hotrod is the sandbox node of the offsite [Kubernetes](../platform/kubernetes.md) cluster: the worker that runs the untrusted work. It runs Talos Linux, and `clusters/offsite/talos/` configures it.

## What it runs

Its `lolwtf.ca/sandbox` taint, declared with its label of the same name in `clusters/offsite/talos/talos.tf`, admits only the pods that tolerate it:

- [Rowbutt](../apps/mate.md) sandboxes, the Kata microVMs. `MATE_SANDBOX_NODE_LABEL` in `clusters/offsite/apps/mate/deployment.yaml` names the label.
- The `infra-offsite` GitHub Actions runners, pinned in `clusters/offsite/apps/arc/kustomization.yaml`.
- The [kthx](../apps/kthx.md) engine's in-cluster build Jobs, once the route in the engine's Settings names the label in `nodeSelector` and the taint in `tolerations`. See [Built apps](../apps/kthx/built-apps.md#builds).
- The DaemonSets that tolerate the taint: Cilium, node-exporter, Vector, Velero's node agent and iperf3.

`/var/mnt/data`, its `data` volume, holds the `local-path` volumes that land on hotrod.

## Reach

Reach it at `hotrod.lolwtf.ca` with `talosctl --context offsite`, as [Issue a talosconfig](../runbooks/issue-a-talosconfig.md) says. It runs no SSH server.

## Quirks

- The NVMe holds the EPHEMERAL partition and the `data` volume; there is no second disk.
- A pod that holds a `local-path` volume on hotrod and does not tolerate the taint cannot be rescheduled: the volume pins it here and the taint refuses it. The `clankerbanker` Datastore in `spindrift-datastores` is such a pod, from before the taint. Its volume moves only through the kthx engine, which owns that namespace.
