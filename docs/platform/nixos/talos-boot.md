---
title: Talos boot
description: The boot server on the three anchors that serves folly's signed iPXE, HookOS and SecureBoot ISO on the bootstrap VLAN behind the boot VIP.
---

Talos boot is the part of each anchor, [spore](../../hosts/spore.md), [capsule](../../hosts/capsule.md) and [forge](../../hosts/forge.md), that serves folly's signed iPXE, HookOS UKI and SecureBoot ISO to machines on the `bootstrap` VLAN and the Kubernetes network. [Tinkerbell](tinkerbell.md), on spore, decides which machine boots what.

The site is the NixOS option `homelab.site`, declared in `nix/profiles/anchor.nix` and set to `folly`. The boot, enrollment and attestation services take their state paths, metric labels, release tag and committed per-site files from it, so the paths in this page read `<site>` where they say `folly`.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `bootstrap` VLAN interface | Gives each anchor its `<HOST>_BOOTSTRAP_IP`, tagged on `end0` | every anchor |
| keepalived `boot` instance | Holds `BOOT_VIP` on the anchor that passes the checks below. It prefers spore, then capsule, then forge, and uses unicast VRRP from the other anchors' bootstrap addresses only. | every anchor |
| dnsmasq TFTP | Serves the signed iPXE, `talos/folly/ipxe-amd64-secureboot.efi`, from `/var/lib/tftpboot` | every anchor |
| `netboot-not-allowed` links | Serve the same iPXE at `<mac>/netboot-not-allowed` for each MAC in `node-macs.json`, the name Smee offers while `allowPXE` is off, for firmware that takes Smee's offer over UniFi's (riptide's does; shale's does not) | spore |
| nginx `talos-boot` | Serves the ISO and HookOS on port 80, at the anchor's bootstrap address and at `BOOT_VIP` | every anchor |
| `talos-boot-mirror` (the mirror) | Fetches and checks the release each hour | every anchor |
| `talos-boot-check` | Exports whether the anchor holds `BOOT_VIP` and passes the check, each minute | every anchor |
| [Talos enrollment](../../apps/talos-enroll.md) | nginx serves `enroll.lolwtf.ca` on port 443 at `BOOT_VIP` in front of talos-enroll; `talos-enroll-check` exports whether it serves and the server's `/metrics`, each minute; CoreDNS answers the name with `BOOT_VIP` | every anchor |

The boot check passes when dnsmasq is active and nginx serves HookOS at the anchor's bootstrap address. The enrollment check passes when nginx serves `enroll.lolwtf.ca` on loopback with a certificate that public roots trust, and talos-enroll answers behind it. keepalived runs each every 5 seconds; two failures of either drop the anchor below every healthy one.

## Boot path

UniFi's DHCP on the bootstrap network and on the Kubernetes network names `BOOT_VIP` as the TFTP and boot server, so a known node netboots on the Kubernetes network and an unknown machine on the bootstrap fallback. Firmware PXE loads the signed iPXE from it, and iPXE fetches the node's script from Smee at `SPORE_BOOTSTRAP_IP`. The script chains HookOS from nginx. When Smee has no script for the MAC, iPXE shows its own menu, whose default chains the same HookOS from `BOOT_VIP`, and the agent waits for a Workflow. [Tinkerbell](tinkerbell.md#boot-path) has the details. HookOS is about 200 MB, too large for TFTP, so it goes over HTTP.

The bootstrap network's DHCP names every anchor's bootstrap address as a resolver and `BOOT_VIP` as the NTP server. The Kubernetes network's DHCP names the anchors' DNS addresses, and folly's Talos nodes take time from them. CoreDNS and chrony answer on every interface of each anchor, and CoreDNS answers `enroll.lolwtf.ca` with `BOOT_VIP` on each.

## Netboot images

iPXE, about 1.2 MB, carries an embedded script that runs `dhcp`, sets `boot-url` to `http://<BOOT_VIP>/talos/folly`, and chains `http://<SPORE_BOOTSTRAP_IP>:7080/ipxe/script/${net0/mac}/auto.ipxe`, Smee's script for the booting MAC. If that fails, it shows a menu with a 10-second timeout. Its default, `hookos`, chains `${boot-url}/hookos-amd64-secureboot-uki.efi` with the command line from `nix/images/hookos-folly.nix`, which a `Hardware`'s script passes too. `enroll` sanboots the signed ISO. On firmware in Setup Mode, its systemd-boot menu offers "Enroll Secure Boot Keys: auto", which enrolls `PK`, `KEK` and `db` from `clusters/folly/talos/secureboot/` and reboots. Select it: systemd-boot enrolls on its own only in a virtual machine. On HP firmware, clear the keys with Secure Boot off, enroll, then turn Secure Boot on, because HP reloads its factory keys when Secure Boot is turned on with no keys. An 800 G2 on BIOS N21 2.37 refuses the `PK` write; 2.63 accepts it. `exit` returns to the firmware. When an item cannot load from `BOOT_VIP`, the script sets `boot-url` to spore's own bootstrap address and tries the item again. If that fails too, iPXE exits to the firmware. sanboot takes no relative URL, which is why the script sets `boot-url`. Before HookOS, the script frees every other image with `imgfree`, because systemd-stub refuses to start while iPXE serves another image's initrd, and passes the command line as arguments, because without Secure Boot systemd-stub takes iPXE's arguments in place of its signed command line.

HookOS is one UKI for every node, signed with the HookOS key. Its signed command line names no worker, and pins the agent image `ghcr.io/jonpulsifer/tink-agent-autoid` by digest. That image sets the agent ID to the MAC of the NIC that holds the default route. The firmware checks iPXE, HookOS and each image iPXE chains against `db`, and [PKI](../pki.md#talos-secure-boot-keys) says which key signs what.

| URL path | File under `/var/lib/talos-boot/folly/` |
| --- | --- |
| `/talos/folly/metal-amd64-secureboot.iso` | `current/metal-amd64-secureboot.iso` |
| `/talos/folly/hookos-amd64-secureboot-uki.efi` | `current/hookos-amd64-secureboot-uki.efi` |

## The mirror

Each image build is its own immutable GitHub release, tagged `talos-folly/<talos_version>-<run id>`. Each anchor's mirror asks the releases API for the newest one of the version and downloads its ISO, iPXE and HookOS. It skips the download while it already serves that release's tag. `.github/scripts/talos-uki-verify.sh`, the image pipeline's check, requires one signature that the committed certificate's key made over the image's own hash: the UKI signing certificate for iPXE, and the HookOS certificate for HookOS. A new release moves `current` to `prev`. A failed run changes neither.

A Talos version bump fails the mirror until that version's release exists. The anchor serves the old release until then. A release without the ISO, iPXE or HookOS also fails it.

## Alerts

The cluster cannot reach the bootstrap VLAN, so each anchor's node exporter carries `talos_boot_vip_held`, `talos_boot_serving`, `talos_enroll_serving`, `talos_boot_mirror_success`, `talos_boot_mirror_last_success_timestamp_seconds` and `talos_boot_uki_info`, which names each slot's version and release. `clusters/folly/monitoring/anchor-vips.yaml` declares the alerts.

| Alert | Meaning |
| --- | --- |
| `AnchorBootVipDown` | No anchor holds `BOOT_VIP` and passes the check |
| `AnchorBootNotServing` | One anchor fails the check or exports no metrics |
| `AnchorBootMirrorStale` | One anchor's mirror has not verified a release for 6 hours |
| `AnchorBootReleasesDiffer` | The anchors serve different releases for 3 hours |
| `AnchorEnrollVipDown` | No anchor holds `BOOT_VIP` and passes the enrollment check |
| `AnchorEnrollNotServing` | One anchor fails the enrollment check or exports no metrics |

## Rules

- Each anchor's switch port must carry the bootstrap VLAN tagged. spore's Smee answers DHCP broadcasts, and VRRP between the anchors runs on the VLAN.
- spore serves the boot files at its own bootstrap address as well as at `BOOT_VIP`. The netboot iPXE falls back to that address when no anchor holds the VIP.
- `talos-uki-verify.sh` runs `sbverify --cert` and also requires exactly one signature. sbverify alone passes a file with several signatures when any one of them verifies.
- A machine on the bootstrap VLAN reaches the anchors directly, where the UniFi firewall cannot filter it. Each anchor's `nixos-fw-bootstrap` chain, from `talos-boot.nix`, runs before the ports the NixOS firewall opens on every interface. Over IPv4 it admits the ports declared for `bootstrap` (TFTP, HTTP and HTTPS, and on spore Smee and the Tink server), DNS, NTP, ping and VRRP from the other anchors' bootstrap addresses, and drops the rest. Over IPv6 it admits only ICMPv6. Declare a new bootstrap service in `networking.firewall.interfaces.bootstrap`, or the chain drops it. The `anchor-boot` check fails if the chain admits ssh, NFS, Garage, an exporter or the Tinkerbell API.
- Traffic from a bootstrap address, `BOOT_VIP` included, takes the routing table numbered `BOOTSTRAP_VLAN`, through a policy rule that systemd-networkd sets on the `bootstrap` interface from `talos-boot.nix`. The table holds the VLAN's own route and a default via the gateway, the first host in `BOOTSTRAP_CIDR`. A request that the gateway routes onto the VLAN from another network therefore passes the NixOS firewall's strict reverse-path filter, and its reply leaves on `bootstrap`. Without the rule the filter drops the request, because the main table's route back is on `end0`.
- dnsmasq sends each TFTP transfer's data from port 69 (`tftp-single-port`), so a transfer is one UDP flow. A gateway reply rule matches only the request's port, so a transfer from a server-chosen port would not cross the gateway, and the conntrack helper does not change that. The `anchor-boot` and `spore-reliability` checks fail without the setting.
- A node on the Kubernetes network reaches the anchors through the gateway, whose policies `kubernetes_to_boot` admit each bootstrap address and `BOOT_VIP` on TCP 80, 443, 7080 (Smee) and 42113 (the Tink server), and UDP 69, 123 and 514 (HookOS's syslog). The anchors answer it only through the policy route on their bootstrap addresses in `talos-boot.nix`: without it, the strict NixOS reverse-path filter drops a request from the Kubernetes network that arrives on `bootstrap`.
- The `anchor-boot` and `spore-reliability` checks in `nix/lib/checks.nix` fail if dnsmasq could lease addresses or answer DHCP.

## Where it lives

- `nix/services/talos-boot.nix`: the VLAN, firewall, dnsmasq, nginx paths, the check and the mirror
- `nix/services/anchor-vips.nix`: the keepalived `boot` instance and its VRRP firewall
- `nix/services/talos-enroll.nix`: the enrollment server, its certificate and its check
- `nix/services/tinkerbell.nix`: Smee, the rest of Tinkerbell and the `netboot-not-allowed` links
- `clusters/folly/config/anchor-topology.json`: `BOOTSTRAP_CIDR`, `BOOTSTRAP_VLAN`, `<HOST>_BOOTSTRAP_IP`, `BOOT_VIP`
- `terraform/network/unifi/folly/bootstrap.tf`: the bootstrap network's DHCP, the boot option and the anchors' switch ports
- `terraform/network/unifi/folly/k8s.tf`: the Kubernetes network's DHCP
- `terraform/network/unifi/folly/firewall.tf`: the policies `kubernetes_to_boot`
- `clusters/folly/talos/talos.tf`: `talos_version`, which names the release
- `clusters/folly/talos/secureboot/uki-signing-cert.pem`, `hookos-signing-cert.pem`: the certificates the mirror checks
- `clusters/folly/talos/netboot.json`: the HookOS release and the agent image digest
- `nix/images/ipxe-folly.nix`, `nix/images/hookos-folly.nix`: the unsigned iPXE, with its menu, and HookOS
- `images/tink-agent-autoid/`: the agent image
- `.github/scripts/talos-uki-verify.sh`: the signature check, shared with the image pipeline

## Related

- [Tinkerbell](tinkerbell.md)
- [Netboot](netboot.md)
- [Lab DNS and time](../network/ingress-and-dns.md#lab-dns-and-time)
- [Provision a node](../../runbooks/provision-a-node.md)
- [Topology](../../reference/topology.md)
