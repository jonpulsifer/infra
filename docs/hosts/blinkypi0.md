---
title: blinkypi0
description: An unplugged Raspberry Pi Zero W with a Blinkt! LED strip whose LED code is not in git.
status: unplugged
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi Zero W
  serial: unknown
  cpu: BCM2835, ARM1176 (1c, armv6l)
  ram: 512 MB LPDDR2
  gpu: Broadcom VideoCore IV
  storage: unknown (microSD)
  os: Raspberry Pi OS Lite
  hat: "Pimoroni Blinkt! (8-pixel APA102 LED strip)"
  case: Flirc Raspberry Pi Zero Case
---

blinkypi0 is a Raspberry Pi Zero W with a Blinkt! LED strip. It is unplugged.

## What it runs

`nix/hosts/blinkypi0.nix` uses the same `nix/profiles/pi-zero.nix` as [radiopi0](radiopi0.md), has no LED service, and is not tested on the hardware.

## Reach

Reach it at `blinkypi0.lolwtf.ca` as the user `pi` when it is plugged in.
