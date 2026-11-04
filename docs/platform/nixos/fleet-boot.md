---
title: fleet-boot
description: The lab's own signed RAM boot image, which attests a folly machine against fleetd and runs the boot fleetd answers, with no container runtime.
---

fleet-boot is folly's own RAM boot image, a kernel and a NixOS systemd initrd packed as one UKI. It attests a machine against [fleetd](../../apps/fleetd.md) as HookOS does, asks fleetd over the session that passed what this boot does, and runs it. The same program ships a second way, as the [Alpine image](#alpine-image). HookOS stays the default boot; the NixOS image boots from the iPXE menu's `fleetboot` item and the Alpine one from `alpine`.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `nix/images/fleet-boot.nix` | Builds the unsigned UKI | Nix |
| `fleet-boot.target` | The initrd's default unit: udev, DHCP, resolved and `fleet-boot.service`; no root | the machine |
| `apps/fleetd/cmd/fleet-boot` | Sets the clock, attests and asks for the run | the machine |
| `apps/fleetd/fleetboot` | Runs and reports the steps | the machine |
| `images/fleet-boot-alpine` | Builds the Alpine image's kernel and initramfs | the containers workflow |
| `.github/scripts/talos-netboot-build.sh` | Packs the Alpine image into a UKI | GitHub Actions |
| `.github/workflows/talos-images.yml` | Signs both with the HookOS key and publishes them | GitHub Actions |
| `talos-boot-mirror` | Mirrors both for nginx, beside HookOS | spore |

## Boot

1. iPXE chains `fleet-boot-amd64-secureboot-uki.efi`. Its signed command line names the same `fleet_attest_url`, `fleet_ntp_server` and `syslog_host` as HookOS's.
2. fleet-boot waits for a default route and steps the clock over SNTP, from an answer that echoes its request.
3. It attests with the `apps/fleetd/client` package, as `tink-attest` does: with the MAC of the NIC the firmware's `BootCurrent` entry names, then each NIC with a default route while fleetd refuses the claim. A verdict stops the tries; another failure gets five, 30 seconds apart.
4. It asks for the run at `/attest/v1/boot/<session>/run`. The session's AK signs each request over the nonce, the route, a sequence number and the body.
5. With no run, or no boot route, the machine waits, attested. fleetd serves the route under its [boot executor](../../apps/fleetd/lifecycle.md#executors).

## Steps

The steps are the `provision` and `provision-image` Templates' in Go, every disk check and refusal included. Each reports `started`, then `succeeded` or `failed`, and a failure, or a report fleetd does not take, stops the run. Nothing is tried again on the machine.

| Step | Does |
| --- | --- |
| `wipe` | Checks the disk by `install_disk_serial`, probes the EFI variable store, and wipes signatures, both GPTs and the first and last MiB. A retirement erases the disk, which passes only when canary blocks change |
| `install` | Downloads the image into memory, checks its sha256 and magic, streams it to the disk, moves the backup GPT, and writes the seed by `payload_kind` |
| `next-boot` | Makes the ESP's entry, or the IPv4 entry after a wipe, BootNext and first in BootOrder, and deletes stale fleet OS entries |
| `reboot` | Reboots, or powers a retired node off, 10 seconds after its report |

A run's install inputs are checked before the wipe, so a malformed run keeps its disk.

## Talos

A Talos class installs as an image too. `talos-images.yml` builds the imager's `secureboot-metal` output, `metal-amd64-secureboot.raw.zst`, with the installer's `talos.config` URL, checks it with `.github/scripts/talos-metal-verify.sh`, and pins it in the Talos classes beside `installer_image` whenever the installer's digest moves. A Talos class with an image needs its installer. After the write, the install sets META key `0x0b`, which Talos fills `${code}` from, in the image's `META` partition: the Talos ADV of `github.com/siderolabs/go-adv`, two 256 KiB copies, as the installer's `--meta 0x0b=<code>` writes it. fleetd's boot executor puts the pinned image in a Talos class's run (`apps/fleetd/fleet/boot.go`). A Talos class with no image pin is refused before the wipe, since fleet-boot runs no installer container. Tinkerbell's `provision` Template still runs the installer.

## Alpine image

`images/fleet-boot-alpine` is the same boot on Alpine's `linux-lts` kernel and busybox, with no systemd: the kernel modules of the lab's NICs, disks, file systems and TPMs, their firmware, kmod, xz, the CA bundle, the static `fleet-boot` binary and `init`. Its Dockerfile builds `fleet-boot` from `apps/fleetd`, prunes the modules with `build-initramfs.sh`, and publishes the kernel, the initramfs and the kernel's uname under `/boot` of an image from `scratch`. `init` mounts the kernel's file systems, loads each present device's driver by modalias, asks for a DHCP lease on every Ethernet NIC and runs `fleet-boot`, which reads the same command line words and does what it does from the NixOS initrd.

The containers workflow builds the image and pins its digest as `fleet_boot_alpine_image` in `clusters/folly/talos/netboot.json`, which rebuilds the netboot release: `talos-netboot-build.sh` exports the pinned image's `/boot`, packs it with `ukify` into `fleet-boot-alpine-amd64-secureboot-uki.efi`, with `bootCmdline` from `nix/images/fleet-boot.nix`, the NixOS image's command line less its systemd unit, and the HookOS key signs it. An all-zero digest is no image yet, and the release carries no Alpine UKI until the first delivery pins one; the mirror on spore serves the release without it. The `fleet-boot-image` check refuses a `menu_default` of `alpine` while the pin is empty.

Alpine's stable branch holds one version of each package, so the image's packages are the branch's newest at build time, and the base image's digest is the pin Renovate moves.

## Rules

- A change to the fleet-boot binary or the packages it imports rebuilds the Talos release, and the Alpine image too.
- The image carries the steps' tools. GNU tar reads a cloud image's sparse member.
- `fleet_boot.kernel` in `clusters/folly/talos/netboot.json` pins the kernel package set, which the `fleet-boot-image` check in `nix/lib/checks.nix` enforces with the command line.
- The HookOS key signs it, so a fleet-boot boot never measures Talos's PCR 7.

## Where it lives

- `nix/images/fleet-boot.nix`: the image and its command line
- `images/fleet-boot-alpine`: the Alpine image
- `apps/fleetd/protocol/boot.go`: the boot routes and what the AK signs
- `nix/images/ipxe-folly.nix`: the `fleetboot` and `alpine` menu items

## Related

- [Talos boot](talos-boot.md)
- [Tinkerbell](tinkerbell.md)
- [fleetd lifecycle](../../apps/fleetd/lifecycle.md)
