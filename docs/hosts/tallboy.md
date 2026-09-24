---
title: tallboy
description: The owner's Windows 11 desktop at folly on the future network, which sends metrics and event logs to folly.
specs:
  vendor: ASUS
  model: ROG Strix G16CHR
  serial: S9PFWT00L382375
  cpu: "Intel Core i7-14700F (20c/28t)"
  ram: 32 GB
  gpu: NVIDIA GeForce RTX 4070
  storage: "1 TB Samsung SSD 990 PRO, 1 TB Micron MTFDKBA1T0QFM"
  os: Windows 11 Pro (build 26200)
---

tallboy is the owner's Windows 11 desktop on folly's [`future`](../platform/network.md#networks) network. The owner works in its NixOS WSL distro, the `wsl` image in `nix/hosts/default.nix`.

## What it runs

- `windows_exporter` on port 9182, and OhmGraphite, a hardware-sensor exporter, on port 4445. `clusters/folly/monitoring/windows-exporters.yaml` declares both as Prometheus targets on folly.
- Vector, which pushes the Windows Event Log to VictoriaLogs

See [Install a Windows desktop](../runbooks/install-a-windows-desktop.md) and [Install Windows monitoring](../runbooks/install-windows-monitoring.md).

## Reach

Reach it at [`tallboy.<tailnet>`](index.md#reach-a-host). `terraform/network/unifi/folly/windows-hosts.tf` reserves its address from `TALLBOY_IP` in `clusters/folly/config/lab-topology.json`.

## Quirks

- Memory Integrity (HVCI) blocks the sensor driver, so tallboy reports no CPU temperature or fan speed.
- The per-host `Windows*` rules resolve when tallboy is off. The chart's `TargetDown` covers the `windows-exporter` job and fires now because [atomic](atomic.md) does not answer.
