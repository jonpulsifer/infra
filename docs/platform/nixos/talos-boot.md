---
title: Talos boot
description: The boot server on spore that gives folly's Talos nodes the signed UKI on the bootstrap VLAN, over UEFI HTTP boot or PXE.
---

Talos boot is the part of [spore](../../hosts/spore.md) that serves folly's signed Talos UKI and SecureBoot ISO to machines on the `bootstrap` VLAN.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `bootstrap` VLAN interface | Gives spore `SPORE_BOOTSTRAP_IP`, tagged on `end0` | spore |
| dnsmasq proxy DHCP | Answers `HTTPClient` requests on `bootstrap` with option 60 and the UKI URL. UniFi leases the address. | spore |
| dnsmasq TFTP | Serves the same UKI at `talos/folly/metal-amd64-secureboot-uki.efi` for firmware with only PXE | spore |
| nginx `spore-pxe` | Serves the UKI, the previous UKI and the ISO on port 80 | spore |
| `spore-talos-boot-mirror` (the mirror) | Fetches and checks the release each hour | spore |

## Boot paths

UEFI HTTP boot takes the address from UniFi and the URL from spore's proxy offer. EDK2 pairs the two offers only when the URL host is an IPv4 literal, so the URL is `http://<SPORE_BOOTSTRAP_IP>/talos/folly/metal-amd64-secureboot-uki.efi`.

Firmware with only PXE needs UniFi's network boot options on the bootstrap network: spore as the TFTP server and the TFTP path above as the file. No network in `terraform/network/unifi/folly/` sets them today. A TFTP transfer of the UKI, about 110 MiB, is untested.

| URL path | File under `/var/lib/spore-talos-boot/folly/` |
| --- | --- |
| `/talos/folly/metal-amd64-secureboot-uki.efi` | `current/metal-amd64-secureboot-uki.efi` |
| `/talos/folly/prev/metal-amd64-secureboot-uki.efi` | `prev/metal-amd64-secureboot-uki.efi` |
| `/talos/folly/metal-amd64-secureboot.iso` | `current/metal-amd64-secureboot.iso` |

## The mirror

The mirror downloads both files from the GitHub release `talos-folly/<talos_version>`. It skips the download while the UKI's ETag is unchanged. `sbverify` checks the UKI against the committed signing certificate. A new release moves `current` to `prev`. A failed run changes neither.

A Talos version bump fails the mirror until that version's release exists. spore serves the old UKI until then.

Its node-exporter metrics are `spore_talos_boot_mirror_success`, `spore_talos_boot_mirror_last_success_timestamp_seconds` and `spore_talos_boot_uki_info`, which names each slot's version. No alert reads them.

## Rules

- spore's switch port must carry the bootstrap VLAN tagged. A DHCP request is a broadcast, so the proxy must be on that VLAN.
- Keep the URL an IPv4 literal that ends in `.efi`, or EDK2 HTTP boot can reject the offer or the file.
- Add no `pxe-service` for client architecture 16. dnsmasq then drops the URL from the reply.
- The `spore-reliability` check in `nix/lib/checks.nix` fails if dnsmasq could lease addresses or answer DHCP on `end0`.

## Where it lives

- `nix/services/spore-talos-boot.nix`: the VLAN, firewall, proxy DHCP, nginx paths and the mirror
- `clusters/folly/config/lab-topology.json`: `BOOTSTRAP_CIDR`, `BOOTSTRAP_VLAN`, `SPORE_BOOTSTRAP_IP`
- `clusters/folly/talos/talos.tf`: `talos_version`, which names the release
- `clusters/folly/talos/secureboot/uki-signing-cert.pem`: the certificate the mirror checks

## Related

- [Netboot](netboot.md)
- [Install Talos on a node](../../runbooks/install-talos-on-a-node.md)
- [Topology](../../reference/topology.md)
