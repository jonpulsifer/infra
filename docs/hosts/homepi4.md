---
title: homepi4
description: A Raspberry Pi 4 kiosk at folly with the 7-inch touch display, which shows the Weather Hub full screen.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 4 Model B Rev 1.4 (8 GB)
  serial: "100000001e657842"
  revision: d03114
  cpu: BCM2711, Cortex-A72 (4c)
  ram: 8 GB LPDDR4-3200
  gpu: Broadcom VideoCore VI
  storage: 32 GB microSD
  os: NixOS 26.05 (Yarara)
  display: "Raspberry Pi 7\" Touch Display"
  case: SmartiPi Touch 2
---

homepi4 is a Raspberry Pi 4 kiosk at folly that shows the [Weather Hub](../apps/hub.md). `nix/hosts/homepi4.nix` uses `nix/profiles/pi4-kiosk.nix`, the same profile as [weatherpi4](weatherpi4.md).

## What it runs

- Cage, a Wayland kiosk compositor, and Firefox in kiosk mode on `https://hub.lolwtf.ca`, from `nix/services/kiosk.nix`
- An iperf3 server. [netbench](../apps/netbench.md) targets it at `homepi4.lolwtf.ca`, so that target fails.

## Reach

Reach it at `homepi4-wifi.lolwtf.ca` or [`homepi4.<tailnet>`](index.md#reach-a-host).

## Quirks

- homepi4 uses the hidden `lab` WLAN. Its wired port has no link, so `homepi4.lolwtf.ca` does not answer.
- homepi4 has no auto-upgrade. See [Repair a kiosk](../runbooks/repair-a-kiosk.md).
