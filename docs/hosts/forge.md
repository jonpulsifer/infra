---
title: forge
description: A Raspberry Pi 5 on NVMe that is the lab's native arm64 build host.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 5 Model B Rev 1.1 (8 GB)
  serial: aed421e548c12e74
  revision: d04171
  cpu: BCM2712, Cortex-A76 (4c)
  ram: 8 GB LPDDR4X-4267
  gpu: Broadcom VideoCore VII
  storage: 256 GB Patriot P300 NVMe
  os: NixOS 26.05 (Yarara)
---

forge is the lab's native arm64 build host, a Raspberry Pi 5 on [Lab Net](../platform/network.md#networks), folly's network for lab hosts. `nix/hosts/forge.nix` configures it.

## What it runs

- Nix builds for the [Raspberry Pi deploys](../runbooks/deploy-a-nixos-host.md), including the armv6l cross-builds
- Docker with buildx for arm64 images
- harmonia, a Nix binary cache behind nginx on port 80, which the firewall blocks. No host trusts its key.

See [Build host and cache](../platform/nixos/build-host-and-cache.md).

## Reach

Reach it at `forge.lolwtf.ca` or [`forge.<tailnet>`](index.md#reach-a-host).

## Quirks

- The EEPROM boot settings are outside git. `BOOT_ORDER=0xf1276` tries the NVMe, then [rackpi5](rackpi5.md) from spore. The `0xf7` in `nix/hosts/rackpi5.nix` skips the NVMe. See [Netboot](../platform/nixos/netboot.md).
- A stock EEPROM update erases the enrolled public key of spore's `/var/lib/pi-boot-sign/private.pem`. HTTP boot fails until the key is enrolled again.
