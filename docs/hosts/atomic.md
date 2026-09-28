---
title: atomic
description: A Windows desktop at folly on the future network that Prometheus on folly cannot scrape.
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

atomic is a Windows desktop on folly's [`future`](../platform/network.md#networks) network, behind a switch port whose native network is `future`. Its setup procedure is [Install a Windows desktop](../runbooks/install-a-windows-desktop.md).

## What it runs

atomic is set up like [tallboy](tallboy.md), with `windows_exporter` and OhmGraphite, a hardware-sensor exporter. No scrape confirms that they run. See [Install Windows monitoring](../runbooks/install-windows-monitoring.md).

## Reach

Reach it at [`atomic.<tailnet>`](index.md#reach-a-host). `terraform/network/unifi/folly/windows-hosts.tf` reserves its address from `ATOMIC_IP` in `clusters/folly/config/lab-topology.json`.

## Quirks

- `clusters/folly/monitoring/windows-exporters.yaml` declares atomic as a scrape target, and its agents do not answer while atomic is on. `WindowsDesktopUnseen` fires for it until the agents are installed. See [Install or update the agents](../runbooks/install-windows-monitoring.md#install-or-update-the-agents).
- The per-host `Windows*` rules in the same file resolve when atomic is off.
