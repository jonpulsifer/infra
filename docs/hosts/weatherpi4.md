---
title: weatherpi4
description: A Raspberry Pi 4 kiosk at offsite that shows the Weather Hub full screen and is reached over the tailnet.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 4 Model B Rev 1.4 (8 GB)
  serial: 10000000cfbd3890
  revision: d03114
  cpu: BCM2711, Cortex-A72 (4c)
  ram: 8 GB LPDDR4-3200
  gpu: Broadcom VideoCore VI
  storage: 32 GB microSD
  os: NixOS 26.05 (Yarara)
---

weatherpi4 is a Raspberry Pi 4 kiosk at offsite that shows the [Weather Hub](../apps/hub.md). `nix/hosts/weatherpi4.nix` uses `nix/profiles/pi4-kiosk.nix`, the same profile as [homepi4](homepi4.md).

## What it runs

- Cage, a Wayland kiosk compositor, and Firefox in kiosk mode on `https://hub.lolwtf.ca`, from `nix/services/kiosk.nix`
- An iperf3 server. [netbench](../apps/netbench.md) targets it at `weatherpi4.lolwtf.ca`, which has no record, so that target fails.

## Reach

Reach it at [`weatherpi4.<tailnet>`](index.md#reach-a-host). It joins the `Goggly` WLAN on offsite's Default network, declared in `terraform/network/unifi/offsite/wlans.tf`, and no `lolwtf.ca` record names it.

## Quirks

- `services.kiosk.public = true` opens TCP port 8080, and nothing listens on it.
- weatherpi4 has no auto-upgrade. See [Repair a kiosk](../runbooks/repair-a-kiosk.md).
