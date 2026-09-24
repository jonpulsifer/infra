---
title: Netboot
description: The network boot service on spore, with x86 PXE boot for folly's Kubernetes network and a signed RAM-boot image that forge falls back to.
---

Netboot is the network boot service on [spore](../../hosts/spore.md). It gives x86 machines on folly's Kubernetes network a PXE boot menu, and publishes a signed RAM-boot image for [forge](../../hosts/forge.md), a headless Raspberry Pi 5.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| UniFi DHCP | Offers spore's `boot/ipxe.efi` | folly gateway, Kubernetes network |
| dnsmasq | Serves TFTP from `/var/lib/tftpboot`, with no DHCP or DNS | spore |
| nginx `spore-pxe` | Serves `/var/lib/tftpboot` and the signed boot files on HTTP port 80 | spore |
| `spore-native-boot-rackpi5` (the publisher) | Signs and publishes the boot files | spore |
| `spore-native-boot-artifact-check` (the artifact check) | Fetches each boot file each minute, and exports `spore_native_boot_artifact_available` | spore |

## x86 PXE

A client loads iPXE over TFTP, and iPXE shows `menu.ipxe` from `/var/lib/tftpboot`. The files are not in git. Restore lost files from backup. `nix build .#netboot` rebuilds the rescue kernel, initrd and iPXE script, but not `boot/ipxe.efi` or `menu.ipxe`.

## Signed HTTP boot

forge's EEPROM boots from NVMe first and falls back to [rackpi5](../../hosts/rackpi5.md), a stateless NixOS image that spore serves over HTTP. The EEPROM settings are outside git. `BOOT_ORDER` digits run right to left: NVMe, HTTP, network, SD, restart. [Change the forge EEPROM](../../runbooks/change-the-forge-eeprom.md) changes them.

```ini
BOOT_ORDER=0xf1276
HTTP_HOST=<SPORE_IP from clusters/folly/config/lab-topology.json>
HTTP_PATH=rackpi5-ram
```

The publisher signs `boot.img` with `/var/lib/pi-boot-sign/private.pem`, outside the Nix store. It keeps each squashfs under the SHA-256 digest pinned in the signed command line. A rollback on spore publishes that generation's files again.

## Rules

- The fallback is forge's only recovery path. Change forge's EEPROM only as [Change the forge EEPROM](../../runbooks/change-the-forge-eeprom.md) says. Without `HTTP_HOST`, `HTTP_PATH` and the HTTP digit 7 in `BOOT_ORDER`, the fallback fails.
- The `BOOT_ORDER` comment in `nix/hardware/pi5/nvme-hat.nix` is capsule's value, not forge's.
- A stock EEPROM update erases the enrolled public key, and HTTP boot then fails.
- If you change the TFTP port range, the digest URL or the nginx unit order, change the `spore-reliability` check in `nix/lib/checks.nix` in the same PR, or `mise run nix:check` fails.

## Alerts

| Alert | Meaning |
| --- | --- |
| `SporeTftpDown` | dnsmasq is not active |
| `SporePxeHttpDown` | nginx is down |
| `SporeRackpi5PublisherDown` | The publisher is not active |
| `SporeNativeBootArtifactUnavailable` | A boot file does not return HTTP 200 |

A failed publisher freezes the fallback at the last published image until spore's 7-day GC removes its squashfs. A fresh spore has no fallback. nginx still serves `/var/lib/tftpboot`.

## Where it lives

- `nix/services/pxe-netboot.nix`: dnsmasq, nginx and the firewall
- `nix/services/spore-native-boot.nix`: the publisher and the artifact check
- `nix/hosts/rackpi5.nix`: the fallback image
- `nix/lib/registry.nix`: `crossHostModules` gives spore the `piBootImg` of `rackpi5`
- `clusters/folly/config/lab-topology.json`: `SPORE_IP`
- `terraform/network/unifi/folly/k8s.tf`: the DHCP boot option
- `clusters/folly/monitoring/spore.yaml`: the alerts

## Related

- [NixOS](../nixos.md)
- [Change the forge EEPROM](../../runbooks/change-the-forge-eeprom.md)
- [Lab DNS and time](../network/ingress-and-dns.md#lab-dns-and-time)
