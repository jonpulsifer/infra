---
title: atomic
description: A Windows desktop at folly on the Management network that Prometheus on folly cannot scrape.
status: unverified
specs:
  vendor: unknown
  model: unknown
  serial: unknown
  cpu: unknown
  ram: unknown
  storage: unknown
  os: Windows
---

atomic is a Windows desktop on folly's [Management](../platform/network.md#networks) network. Its setup procedure is [Install a Windows desktop](../runbooks/install-a-windows-desktop.md).

## What it runs

atomic is set up like [tallboy](tallboy.md), with `windows_exporter` and OhmGraphite, a hardware-sensor exporter. No scrape confirms that they run. See [Install Windows monitoring](../runbooks/install-windows-monitoring.md).

## Reach

Reach it at [`atomic.<tailnet>`](index.md#reach-a-host). `terraform/network/unifi/folly/windows-hosts.tf` reserves its address from `ATOMIC_IP` in `clusters/folly/config/lab-topology.json`.

## Quirks

- `clusters/folly/monitoring/windows-exporters.yaml` declares atomic as a scrape target, and atomic does not answer. The chart's `TargetDown` alert fires for the `windows-exporter` job because of it.
- The per-host `Windows*` rules in the same file resolve when atomic is off.
