---
title: blinkypi0
description: "An unplugged Raspberry Pi Zero W with a Blinkt! LED strip. Its minimal NixOS config has no LED service."
status: unplugged
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi Zero W
  year: "~2017"
  cpu: BCM2835, ARM1176 (armv6l)
  ram: 512 MB LPDDR2
  gpu: Broadcom VideoCore IV
  os: Raspberry Pi OS Lite
  hat: "Pimoroni Blinkt! (8-pixel APA102 LED strip)"
  case: Flirc Raspberry Pi Zero Case
---

Pi Zero W with a [Blinkt!](https://github.com/pimoroni/blinkt) 8-pixel LED strip in a Flirc case.

Unplugged. In the flake as `nixosConfigurations.blinkypi0` (`nix/hosts/blinkypi0.nix`, sharing `nix/hardware/pi0.nix` with [radiopi0](radiopi0.md) — same armv6l cross-compile constraints, see [NixOS](../platform/nixos.md)).

Config is minimal: tailscale + ssh + wiringpi only, no mise-dotfiles or ddnsd (mise has no armv6l release).

NixOS config carries no LED-driving service; that code is not in git.
