---
title: fleet-boot
description: The lab's own signed RAM boot image, which attests a folly machine against fleetd and runs the boot fleetd answers, with no container runtime.
---

fleet-boot is folly's own RAM boot image, a kernel and a NixOS systemd initrd packed as one UKI. It attests a machine against [fleetd](../../apps/fleetd.md) as HookOS does, then asks fleetd over the session that passed what this boot does. HookOS stays the default boot; fleet-boot boots from the iPXE menu's `fleetboot` item.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `nix/images/fleet-boot.nix` | Builds the kernel, the initrd and the unsigned UKI | Nix |
| `fleet-boot.target` | The initrd's default unit: udev, networkd's DHCP, resolved and `fleet-boot.service`. No root is mounted | the machine |
| `apps/fleetd/cmd/fleet-boot` | Sets the clock, attests and asks for the run | the machine |
| `.github/workflows/talos-images.yml` | Builds the UKI, signs it with the HookOS key and publishes it in the Talos release | GitHub Actions |
| `talos-boot-mirror` | Mirrors and checks the UKI, which nginx serves beside HookOS | spore |

## Boot

1. iPXE chains `fleet-boot-amd64-secureboot-uki.efi` from spore. Its signed command line names `fleet_attest_url`, `fleet_ntp_server` and `syslog_host`, the same values as HookOS's.
2. fleet-boot waits for a default route, then steps the clock from `fleet_ntp_server` over SNTP, checking that the answer echoes its request, and writes the RTC.
3. It attests with the `apps/fleetd/client` package, as `tink-attest` does: with the MAC of the NIC the firmware's `BootCurrent` entry names, then each NIC that holds a default route while fleetd refuses the claim. A verdict stops the tries; another failure gets five, 30 seconds apart.
4. It asks fleetd for the run at `/attest/v1/boot/<session>/run`. The session's AK signs each request over the nonce, the route, a sequence number and the body.
5. fleet-boot logs the run and runs no step; a fleetd that holds no run, or serves no boot route, leaves the machine waiting, attested.

fleet-boot logs to the journal, to `tty0` and `ttyS0`, and over syslog to spore, where rsyslog keeps the lines under the identifier `hookos` with the program `fleet-boot`.

## Rules

- A change to the fleet-boot binary or the packages it imports rebuilds the Talos release.
- The image carries the tools the steps run: sgdisk, util-linux, xz, zstd, gzip, GNU tar, efibootmgr and nvme-cli. GNU tar reads the sparse member of a cloud image tarball.
- `fleet_boot.kernel` in `clusters/folly/talos/netboot.json` pins the kernel package set. The `fleet-boot-image` check in `nix/lib/checks.nix` fails when nixpkgs has no such set, on a missing `fleet-boot.target`, or on a fleetd, NTP server or syslog receiver HookOS does not name.
- The HookOS key signs it, so a fleet-boot boot never measures Talos's PCR 7.

## Where it lives

- `nix/images/fleet-boot.nix`: the image, its modules and its command line
- `apps/fleetd/cmd/fleet-boot/`: the program
- `apps/fleetd/protocol/boot.go`: the boot routes and what the AK signs
- `nix/images/ipxe-folly.nix`: the `fleetboot` menu item
- `.github/scripts/talos-netboot-build.sh`, `talos-netboot-verify.sh`: the signature and its checks

## Related

- [Talos boot](talos-boot.md)
- [Tinkerbell](tinkerbell.md)
- [fleetd attestation](../../apps/fleetd/attestation.md)
- [PKI](../pki.md#talos-secure-boot-keys)
