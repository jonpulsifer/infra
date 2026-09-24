---
title: radiopi0
description: A Raspberry Pi Zero W with a pHAT BEAT that runs Raspbian and a CloudEvents LED service that is not in git.
status: off-git
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi Zero W Rev 1.1
  serial: 0000000056f8a6ff
  revision: 9000c1
  cpu: BCM2835, ARM1176 (1c, armv6l)
  ram: 512 MB LPDDR2
  gpu: Broadcom VideoCore IV
  storage: 32 GB microSD
  os: Raspbian 10 (buster)
  hat: "Pimoroni pHAT BEAT (audio DAC, two 7-pixel LED bars)"
  case: Pimoroni Pirate Radio
---

radiopi0 is a Raspberry Pi Zero W on [Lab Net](../platform/network.md#networks), folly's network for lab hosts. It lights its pHAT BEAT LEDs when it receives a CloudEvent. It runs Raspbian, and its NixOS config is not applied.

## What it runs

- `cloudevents-receiver`, a Flask service that drives the LEDs on a `dev.pulsifer.radio.request` CloudEvent. Its code is in `/usr/local/bin` on the host and is not in git.
- A node exporter, which `clusters/folly/monitoring/local-node-exporters.yaml` declares as a Prometheus target on folly at `RADIOPI0_IP`

## Reach

Reach it at `radiopi0.lolwtf.ca` as the user `pi`.

## Quirks

- `nix/hosts/radiopi0.nix` builds on [forge](forge.md) and has no LED service and no node exporter. If you apply it, folly fires `PrometheusTargetMissing`.
- `phatbeatd`, the pHAT BEAT audio daemon, fails at boot.
