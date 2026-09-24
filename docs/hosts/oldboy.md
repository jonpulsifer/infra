---
title: oldboy
description: A free-tier Compute Engine VM in the homelab-ng project that exists to accumulate uptime, and whose boot is unverified.
status: unverified
specs:
  vendor: Google Cloud
  model: GCE e2-micro (free tier)
  serial: n/a (virtual)
  cpu: 2 shared vCPU
  ram: 1 GB
  storage: 16 GB pd-standard
  os: NixOS 26.05 (Yarara)
---

oldboy is a Compute Engine VM in the `homelab-ng` GCP project. Its job is to stay up for as long as it can. `terraform/gcp/projects/homelab-ng/compute.tf` declares the instance, its disk and its image with no condition, so Atlantis applies them. No check confirms that the VM boots.

## What it runs

`nix/hosts/oldboy.nix` adds `nix/images/gce.nix` to `nix/profiles/fleet.nix`, the modules every deployed host gets. The `nix-image-builder` workflow uploads the image to the `homelab-ng-free` bucket, and `compute.tf` makes the disk from the newest one.

## Reach

No DNS record or tailnet device names oldboy.

## Quirks

- Secure Boot is off, because GCE's firmware rejects the unsigned NixOS bootloader. The vTPM and integrity monitoring are on.
