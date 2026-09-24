---
title: rackpi5
description: The image-only NixOS config that spore signs and serves, and that forge boots over HTTP when its NVMe does not boot.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 5, on forge's board
  serial: n/a (image)
  cpu: n/a (image)
  ram: n/a (image)
  storage: none (squashfs Nix store from spore, in RAM)
  os: NixOS 26.05 (Yarara)
---

rackpi5 is an image with no hardware of its own. `nix/hosts/default.nix` declares it with `kind = "image"`. [forge](forge.md) boots it when forge's NVMe does not boot.

## What it runs

rackpi5 is a stateless system in RAM with sshd. sshd accepts the SSH keys of `jawn` and of `rowbutt`, the host user for [Rowbutt](../apps/mate.md). [spore](spore.md) signs and serves the image over HTTP. See [Netboot](../platform/nixos/netboot.md).

## Reach

rackpi5 runs on forge's board, so it answers at `forge.lolwtf.ca`. Its host key differs from forge's and changes on each boot. Connect with a throwaway known_hosts:

```bash
ssh -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no forge.lolwtf.ca
```

The initrd sshd answers on port 2222 and accepts only jawn's keys.

## Quirks

- The image changes only when spore deploys a new generation.
