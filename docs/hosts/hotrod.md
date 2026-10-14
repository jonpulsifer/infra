---
title: hotrod
description: An HP ProDesk 600 G6 mini PC that is the offsite cluster's sandbox node, the worker that runs the untrusted work, on Talos Linux.
specs:
  vendor: HP
  model: ProDesk 600 G6 Desktop Mini PC
  serial: MXL3122Y9Y
  sku: "692B2UT#ABA"
  cpu: "Intel Core i5-10500T @ 2.30GHz (6c/12t)"
  ram: 16 GB DDR4-3200 SODIMM, one module in DIMM1
  gpu: Intel UHD Graphics 630
  storage: 256 GB Samsung PM9A1 NVMe (/dev/nvme0n1)
  network: Intel I219-LM 1 GbE as eno1; the Wi-Fi has no driver
  os: Talos Linux 1.14
  firmware: S22 Ver. 02.27.00, UEFI, Secure Boot off
  tpm: TPM 2.0
---

hotrod is the sandbox node of the offsite [Kubernetes](../platform/kubernetes.md) cluster: the worker that runs the untrusted work. It runs Talos Linux, and `clusters/offsite/talos/` configures it.

## What it runs

Its `lolwtf.ca/sandbox` taint, declared with its label of the same name in `clusters/offsite/talos/talos.tf`, admits only the pods that tolerate it:

- [Rowbutt](../apps/mate.md) sandboxes, the Kata microVMs. `MATE_SANDBOX_NODE_LABEL` in `clusters/offsite/apps/mate/deployment.yaml` names the label.
- The `infra-offsite` GitHub Actions runners, pinned in `clusters/offsite/apps/arc/kustomization.yaml`.
- The [kthx](../apps/kthx.md) engine's in-cluster build Jobs, once the route in the engine's Settings names the label in `nodeSelector` and the taint in `tolerations`. See [Built apps](../apps/kthx/built-apps.md#builds).
- The DaemonSets that tolerate the taint: Cilium, node-exporter, Vector, Velero's node agent and iperf3.

`/var/mnt/data`, its `data` volume, holds the `local-path` volumes that land on hotrod. The `i915` extension loads the GPU's driver, and no device plugin on offsite exposes it to pods.

## Reach

Reach it at `hotrod.lolwtf.ca` with `talosctl --context offsite --nodes hotrod.lolwtf.ca`. It runs no SSH server.

## Quirks

- The NVMe holds the EPHEMERAL partition and the `data` volume; there is no second disk.
- Memory runs single-channel: the second SODIMM slot is empty.
- A pod that holds a `local-path` volume on hotrod and does not tolerate the taint cannot be rescheduled: the volume pins it here and the taint refuses it. No such pod remains, and the taint keeps a new one away.
