---
title: Talos boot
description: The boot server on spore that gives folly's Talos nodes the signed UKI on the bootstrap VLAN, through Tinkerbell's PXE answers, and serves the signed iPXE and HookOS that the path loads.
---

Talos boot is the part of [spore](../../hosts/spore.md) that serves folly's signed Talos UKI and SecureBoot ISO to machines on the `bootstrap` VLAN, with the signed iPXE and HookOS UKI that the netboot path loads. [Tinkerbell](tinkerbell.md) decides which machine boots what.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `bootstrap` VLAN interface | Gives spore `SPORE_BOOTSTRAP_IP`, tagged on `end0` | spore |
| Smee | Answers PXE on `bootstrap` as a proxy DHCP server. UniFi leases the address. | spore |
| dnsmasq TFTP | Serves the signed iPXE, `talos/folly/ipxe-amd64-secureboot.efi`, from `/var/lib/tftpboot`. The same file is at `<mac>/netboot-not-allowed` for each MAC in `node-macs.json`, the name Smee offers while `allowPXE` is off, for firmware that takes Smee's offer over UniFi's (riptide's does; shale's does not). | spore |
| nginx `spore-pxe` | Serves the UKI, its iPXE script, the previous UKI, the ISO and HookOS on port 80 | spore |
| `spore-talos-boot-mirror` (the mirror) | Fetches and checks the release each hour | spore |

## Boot path

Firmware PXE takes the address and the boot file from UniFi's offer on the bootstrap network, then loads the signed iPXE over TFTP. iPXE fetches the node's script from Smee, and the script chains HookOS from nginx. When Smee has no script for the MAC, iPXE chains the UKI's script from nginx instead, and that boots the UKI. [Tinkerbell](tinkerbell.md#boot-path) has the details. The UKI is about 280 MB, too large for TFTP, so it goes over HTTP.

## Netboot images

iPXE, about 1.2 MB, carries an embedded script that runs `dhcp`, sets `boot-url` to `http://<SPORE_BOOTSTRAP_IP>/talos/folly`, and chains `http://<SPORE_BOOTSTRAP_IP>:7080/ipxe/script/${net0/mac}/auto.ipxe`, Smee's script for the booting MAC. If that fails, it chains `${boot-url}/metal-amd64-secureboot-uki.ipxe`, and if that fails too, iPXE exits to the firmware.

The image build writes the UKI's script with `.github/scripts/talos-uki-ipxe.sh` from the UKI's own `.cmdline` section. The script is a menu with a 10-second timeout. Its default, `install`, boots the UKI. `enroll` sanboots the signed ISO. On firmware in Setup Mode, its systemd-boot menu offers "Enroll Secure Boot Keys: auto", which enrolls `PK`, `KEK` and `db` from `clusters/folly/talos/secureboot/` and reboots. Select it: systemd-boot enrolls on its own only in a virtual machine. On HP firmware, clear the keys with Secure Boot off, enroll, then turn Secure Boot on, because HP reloads its factory keys when Secure Boot is turned on with no keys. An 800 G2 on BIOS N21 2.37 refuses the `PK` write; 2.63 accepts it. `exit` returns to the firmware. sanboot takes no relative URL, which is why the embedded script sets `boot-url`. On the `install` path, the script frees itself with `imgfree`, because systemd-stub refuses to start while iPXE serves another image's initrd, and passes the command line as arguments, because without Secure Boot systemd-stub takes iPXE's arguments in place of its signed command line. iPXE fills in `${uuid}`, `${mac}` and `${serial}`.

HookOS is one UKI for every node, signed with the HookOS key. Its signed command line names no worker, and pins the agent image `ghcr.io/jonpulsifer/tink-agent-autoid` by digest. That image sets the agent ID to the MAC of the NIC that holds the default route. The firmware checks iPXE, HookOS and each image iPXE chains against `db`, and [PKI](../pki.md#talos-secure-boot-keys) says which key signs what.

| URL path | File under `/var/lib/spore-talos-boot/folly/` |
| --- | --- |
| `/talos/folly/metal-amd64-secureboot-uki.efi` | `current/metal-amd64-secureboot-uki.efi` |
| `/talos/folly/metal-amd64-secureboot-uki.ipxe` | `current/metal-amd64-secureboot-uki.ipxe` |
| `/talos/folly/prev/metal-amd64-secureboot-uki.efi` | `prev/metal-amd64-secureboot-uki.efi` |
| `/talos/folly/metal-amd64-secureboot.iso` | `current/metal-amd64-secureboot.iso` |
| `/talos/folly/hookos-amd64-secureboot-uki.efi` | `current/hookos-amd64-secureboot-uki.efi` |

## The mirror

Each image build is its own immutable GitHub release, tagged `talos-folly/<talos_version>-<run id>`. The mirror asks the releases API for the newest one of the version and downloads its five files. It skips the download while the UKI's ETag is unchanged. `.github/scripts/talos-uki-verify.sh`, the image pipeline's check, requires one signature that the committed certificate's key made over the image's own hash: the UKI signing certificate for the UKI and iPXE, and the HookOS certificate for HookOS. A new release moves `current` to `prev`. A failed run changes neither.

A Talos version bump fails the mirror until that version's release exists. spore serves the old UKI until then. A release without the UKI's script, iPXE or HookOS also fails it.

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
- `clusters/folly/talos/secureboot/uki-signing-cert.pem`, `hookos-signing-cert.pem`: the certificates the mirror checks
- `clusters/folly/talos/netboot.json`: the HookOS release and the agent image digest
- `nix/images/ipxe-folly.nix`, `nix/images/hookos-folly.nix`: the unsigned iPXE and HookOS
- `images/tink-agent-autoid/`: the agent image
- `.github/scripts/talos-uki-verify.sh`: the signature check, shared with the image pipeline

## Related

- [Tinkerbell](tinkerbell.md)
- [Netboot](netboot.md)
- [Enroll a Talos node](../../runbooks/enroll-a-talos-node.md)
- [Topology](../../reference/topology.md)
