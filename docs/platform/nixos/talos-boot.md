---
title: Talos boot
description: The boot server on spore that gives folly's Talos nodes the signed UKI on the bootstrap VLAN, through Tinkerbell's PXE answers.
---

Talos boot is the part of [spore](../../hosts/spore.md) that serves folly's signed Talos UKI and SecureBoot ISO to machines on the `bootstrap` VLAN. [Tinkerbell](tinkerbell.md) decides which machine boots what.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `bootstrap` VLAN interface | Gives spore `SPORE_BOOTSTRAP_IP`, tagged on `end0` | spore |
| Smee | Answers PXE on `bootstrap` as a proxy DHCP server. UniFi leases the address. | spore |
| dnsmasq TFTP | Serves the signed iPXE that Smee's offer names, from `/var/lib/tftpboot` | spore |
| nginx `spore-pxe` | Serves the UKI, the previous UKI and the ISO on port 80 | spore |
| `spore-talos-boot-mirror` (the mirror) | Fetches and checks the release each hour | spore |

## Boot path

Firmware PXE takes the address from UniFi and the boot file from Smee's proxy offer, then loads the signed iPXE over TFTP. iPXE fetches the node's script from Smee, and the script chains the UKI from nginx. [Tinkerbell](tinkerbell.md#boot-path) has the details and what the path still lacks.

| URL path | File under `/var/lib/spore-talos-boot/folly/` |
| --- | --- |
| `/talos/folly/metal-amd64-secureboot-uki.efi` | `current/metal-amd64-secureboot-uki.efi` |
| `/talos/folly/prev/metal-amd64-secureboot-uki.efi` | `prev/metal-amd64-secureboot-uki.efi` |
| `/talos/folly/metal-amd64-secureboot.iso` | `current/metal-amd64-secureboot.iso` |

## The mirror

Each image build is its own immutable GitHub release, tagged `talos-folly/<talos_version>-<run id>`. The mirror asks the releases API for the newest one of the version and downloads both files from it. It skips the download while the UKI's ETag is unchanged. `.github/scripts/talos-uki-verify.sh`, the image pipeline's check, requires one signature that the committed signing certificate's key made over the UKI's own image hash. A new release moves `current` to `prev`. A failed run changes neither.

A Talos version bump fails the mirror until that version's release exists. spore serves the old UKI until then.

Its node-exporter metrics are `spore_talos_boot_mirror_success`, `spore_talos_boot_mirror_last_success_timestamp_seconds` and `spore_talos_boot_uki_info`, which names each slot's version. No alert reads them.

## Rules

- spore's switch port must carry the bootstrap VLAN tagged. A DHCP request is a broadcast, so the proxy must be on that VLAN.
- `talos-uki-verify.sh` runs `sbverify --cert` and also requires exactly one signature. sbverify alone passes a file with several signatures when any one of them verifies.
- spore's ports that the firewall opens on every interface also answer at `SPORE_BOOTSTRAP_IP`. A machine on the bootstrap VLAN reaches spore directly, so the UniFi firewall cannot filter it.
- The `spore-reliability` check in `nix/lib/checks.nix` fails if dnsmasq could lease addresses or answer DHCP.

## Where it lives

- `nix/services/spore-talos-boot.nix`: the VLAN, firewall, nginx paths and the mirror
- `nix/services/tinkerbell.nix`: Smee and the rest of Tinkerbell
- `clusters/folly/config/lab-topology.json`: `BOOTSTRAP_CIDR`, `BOOTSTRAP_VLAN`, `SPORE_BOOTSTRAP_IP`
- `clusters/folly/talos/talos.tf`: `talos_version`, which names the release
- `clusters/folly/talos/secureboot/uki-signing-cert.pem`: the certificate the mirror checks
- `.github/scripts/talos-uki-verify.sh`: the UKI signature check, shared with the image pipeline

## Related

- [Tinkerbell](tinkerbell.md)
- [Netboot](netboot.md)
- [Enroll a Talos node](../../runbooks/enroll-a-talos-node.md)
- [Topology](../../reference/topology.md)
