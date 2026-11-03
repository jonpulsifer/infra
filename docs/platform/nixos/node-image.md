---
title: NixOS node image
description: The signed disk image a folly node of the nixos class boots, how CI builds and signs it, and how its first boot reads the fleet seed.
---

The NixOS node image is the disk image that [fleetd](../../apps/fleetd.md) installs on a folly node whose class has the `nixos-image` payload. `nix/images/node-nixos.nix` declares it, the flake publishes it as `packages.x86_64-linux.node-nixos`, and the `provision-image` Template writes it to the node's disk. It carries the fleet baseline, `nix/profiles/fleet.nix`, and no SOPS secret.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `image.repart` | Builds the GPT image with systemd-repart from the configuration's closure | Nix |
| `boot.uki` | Packs the kernel, initrd and command line into one UKI | Nix |
| `.github/workflows/node-images.yml` | Builds the image, signs the UKI, publishes the release and pins it | GitHub Actions |
| `fleet-seed.service` | Fetches the node's seed on the first boot | the node |

## Partitions

| Partition | Label | Size | Contents |
| --- | --- | --- | --- |
| EFI system partition, vfat | `ESP` | 512 MB | The UKI at `/EFI/BOOT/BOOTX64.EFI`, and `fleet-seed.json` once the install writes it |
| Root, ext4 | `root` | The closure, then the disk | The Nix store and the system |

The firmware loads the UKI from the removable path, so the image has no boot loader. The root mounts by partition label at `/`, the ESP at `/boot`. On the first boot `systemd-repart` in the initrd grows the root to the end of the disk.

## Build and signing

A push to `main` that changes the image's inputs, or a dispatch, runs the workflow. It builds `.#node-nixos`, reads the ESP's offset from the partition table and copies the UKI out with mtools. `sbsign` signs it with the UKI key in 1Password, which also signs iPXE, and mtools writes it back in place. `.github/scripts/talos-uki-verify.sh` checks that the UKI in the image carries one signature that `clusters/folly/talos/secureboot/uki-signing-cert.pem` verifies.

The workflow compresses the image with zstd to `nixos-node-amd64.img.zst` and publishes it as the immutable release `node-images/<run id>`. A `pin` job writes the asset's URL, its `sha256:` digest and the format `raw.zst` into the `nixos` class of `clusters/folly/fleet/classes.json`, through a pull request the continuous-delivery App opens and merges.

## First boot

The install writes `fleet-seed.json` on the ESP: fleetd's seed URL, the machine's UUID and the install code. After the network is up, `fleet-seed.service` fetches the seed from that URL with the UUID from `/sys/class/dmi/id/product_uuid` and the code, and stores it at `/var/lib/fleet/seed.json`, mode `0600`. It sets the seed's name as the transient hostname, logs the profile and deletes the file on the ESP. fleetd marks the device `active` on that read. A boot that finds the stored seed skips the unit.

## Rules

- A node under Secure Boot cannot sign a UKI of its own, so the image has no Nix daemon, no `nixos-rebuild switch` and no auto-upgrade. An update is a new image and a reprovision.
- The image has no static hostname. `hostnamed` keeps a static name over a transient one, and the seed's name would lose.
- The seed is served once. A fetch that fails after fleetd answered needs a new provision.
- The pin fails when the table has no `nixos` class.

## Where it lives

- `nix/images/node-nixos.nix`: the image, the partitions and `fleet-seed.service`
- `nix/hosts/default.nix`: the `node-nixos` registry entry
- `.github/workflows/node-images.yml`: the build, the signature, the release and the pin
- `clusters/folly/fleet/classes.json`: `image`, `image_digest` and `image_format` of the `nixos` class

## Related

- [fleetd attestation and installation](../../apps/fleetd/attestation.md)
- [Talos boot](talos-boot.md)
- [Tinkerbell](tinkerbell.md)
- [PKI](../pki.md#talos-secure-boot-keys)
