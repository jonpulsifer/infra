---
title: Talos boot
description: The boot server on spore that serves folly's signed iPXE, HookOS and SecureBoot ISO on the bootstrap VLAN, beside fleetd's enrollment name.
---

Talos boot is the part of [spore](../../hosts/spore.md) that serves folly's signed iPXE, HookOS UKI and SecureBoot ISO to machines on the Kubernetes network, from spore's address on the `bootstrap` VLAN. [fleetd](../../apps/fleetd.md) serves the enrollment name's HTTPS at the same address, and [Tinkerbell](tinkerbell.md), also on spore, decides which machine boots what.

The site is the NixOS option `homelab.site`, declared in `nix/profiles/anchor.nix` and set to `folly`. The boot services take their state paths, metric labels, release tag and committed per-site files from it, so the paths in this page read `<site>` where they say `folly`.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `bootstrap` VLAN interface | Gives spore its `SPORE_BOOTSTRAP_IP`, tagged on `end0` | spore |
| dnsmasq TFTP | Serves the signed iPXE, `talos/folly/ipxe-amd64-secureboot.efi`, from `/var/lib/tftpboot` | spore |
| `netboot-not-allowed` links | Serve the same iPXE at `<mac>/netboot-not-allowed` for each MAC NetBox holds, the name Smee offers while `allowPXE` is off, for firmware that takes Smee's offer over UniFi's (riptide's does; shale's does not). Smee is off on spore, so nothing asks for them; [fleetd](../../apps/fleetd.md) still makes and removes them under `/var/lib/tftpboot` on each reconcile pass | spore |
| nginx `talos-boot` | Serves the ISO and HookOS on port 80 at `SPORE_BOOTSTRAP_IP` | spore |
| HookOS syslog | rsyslog on UDP 514 at `SPORE_BOOTSTRAP_IP`, into spore's journal under the identifier `hookos` (`hookos-syslog.nix`). [Tinkerbell](tinkerbell.md#logs-and-pxe-state) says how to read it | spore |
| `talos-boot-mirror` (the mirror) | Fetches and checks the release each hour | spore |
| fleetd's boot listener | Serves `enroll.lolwtf.ca` on port 443 at `SPORE_BOOTSTRAP_IP` with a Let's Encrypt certificate from DNS-01: the device flow under `/attest/` and a node's first config at `/talos/config`. The anchors' CoreDNS answers the name with `SPORE_BOOTSTRAP_IP` | spore |
| `talos-boot-check` | Exports whether spore serves the boot files and the enrollment name, each minute | spore |

The boot check passes when dnsmasq is active and nginx serves HookOS at spore's bootstrap address. The HTTPS check passes when fleetd answers `/healthz` for `enroll.lolwtf.ca` at that address with a certificate that public roots trust.

## Boot path

UniFi's DHCP on the Kubernetes network names `SPORE_BOOTSTRAP_IP` as the TFTP and boot server, so every machine on a node port netboots there, known or not. [Kea](kea.md) on spore holds the same offer for the day the network relays its DHCP there. Firmware PXE loads the signed iPXE from it, and iPXE shows its menu, whose default chains HookOS from nginx at the same address. HookOS attests against fleetd before its agent waits for a Workflow. [Tinkerbell](tinkerbell.md#boot-path) has the details. HookOS is about 200 MB, too large for TFTP, so it goes over HTTP.

The bootstrap network has no DHCP: it holds spore's boot address. The Kubernetes network's DHCP names the anchors' DNS addresses, and folly's Talos nodes take time from them. CoreDNS and chrony answer on every interface of each anchor.

## Netboot images

iPXE is about 1.2 MB. Its embedded script runs DHCP, sets `boot-url` to `http://<SPORE_BOOTSTRAP_IP>/talos/folly` and asks Smee for nothing: with Smee on, Smee's per-MAC script boots the same HookOS the menu boots.

### Menu

iPXE displays a menu with a 10-second timeout.

| Item | Action |
| --- | --- |
| `hookos` (default) | Load `${boot-url}/hookos-amd64-secureboot-uki.efi` with the command line from `nix/images/hookos-folly.nix`. Hardware scripts use the same command line. |
| `enroll` | Use sanboot to load the signed ISO. |
| `exit` | Return to firmware. An item that cannot load also returns to firmware. |

### Secure Boot enrollment

In Setup Mode, the ISO's systemd-boot menu offers "Enroll Secure Boot Keys: auto". This loads `PK`, `KEK` and `db` from `clusters/folly/talos/secureboot/`, then reboots.

Select the enrollment item. systemd-boot enrolls automatically only in a virtual machine.

On HP firmware, clear the keys with Secure Boot off. Enroll the keys, then enable Secure Boot. HP restores factory keys if Secure Boot is enabled with no keys present.

An 800 G2 with BIOS N21 2.37 refuses the `PK` write. Version 2.63 accepts it.

### iPXE constraints

- sanboot requires an absolute URL, so the script sets `boot-url`.
- Before HookOS starts, `imgfree` releases other images. systemd-stub refuses to start while iPXE serves another image's initrd.
- The script passes the command line as arguments. Without Secure Boot, systemd-stub uses those arguments instead of its signed command line.

### HookOS image

HookOS is one UKI for every node, signed with the HookOS key. Its signed command line names no worker, pins the agent image `ghcr.io/jonpulsifer/tink-agent-autoid` by digest, and names `fleet_attest_url` and `fleet_ntp_server`. That image sets the agent ID to the MAC of the NIC that holds the default route, and attests before the agent starts. The firmware checks iPXE, HookOS and each image iPXE chains against `db`, and [PKI](../pki.md#talos-secure-boot-keys) says which key signs what.

| URL path | File under `/var/lib/talos-boot/folly/` |
| --- | --- |
| `/talos/folly/metal-amd64-secureboot.iso` | `current/metal-amd64-secureboot.iso` |
| `/talos/folly/hookos-amd64-secureboot-uki.efi` | `current/hookos-amd64-secureboot-uki.efi` |

## The mirror

Each image build is its own immutable GitHub release, tagged `talos-folly/<talos_version>-<run id>`. The mirror asks the releases API for the newest one of the version and downloads its ISO, iPXE and HookOS. It skips the download while it already serves that release's tag. `.github/scripts/talos-uki-verify.sh`, the image pipeline's check, requires one signature that the committed certificate's key made over the image's own hash: the UKI signing certificate for iPXE, and the HookOS certificate for HookOS. A new release moves `current` to `prev`. A failed run changes neither.

A Talos version bump fails the mirror until that version's release exists. spore serves the old release until then. A release without the ISO, iPXE or HookOS also fails it.

## Alerts

The cluster cannot reach the bootstrap VLAN, so spore's node exporter carries `talos_boot_serving`, `talos_boot_https_serving`, `talos_boot_mirror_success`, `talos_boot_mirror_last_success_timestamp_seconds` and `talos_boot_uki_info`, which names each slot's version and release. `clusters/folly/monitoring/fleetd-rules.yaml` declares the alerts.

| Alert | Meaning |
| --- | --- |
| `BootFilesNotServed` | spore fails the boot check or exports no metrics |
| `EnrollmentNameNotServed` | spore fails the HTTPS check or exports no metrics |
| `BootMirrorStale` | The mirror has not verified a release for 6 hours |

## Rules

- spore's switch port must carry the bootstrap VLAN tagged, for the boot address and the gateway's relayed DHCP. capsule's and forge's ports do not carry it.
- `talos-uki-verify.sh` runs `sbverify --cert` and also requires exactly one signature. sbverify alone passes a file with several signatures when any one of them verifies.
- A machine on the bootstrap VLAN reaches spore directly, where the UniFi firewall cannot filter it. spore's `nixos-fw-bootstrap` chain, from `talos-boot.nix`, runs before the ports the NixOS firewall opens on every interface. Over IPv4 it admits the ports declared for `bootstrap` (TFTP, HTTP, HTTPS, relayed DHCP, HookOS's syslog and the Tink server, and Smee's while Smee is on), DNS, NTP and ping, and drops the rest. Over IPv6 it admits only ICMPv6. Declare a new bootstrap service in `networking.firewall.interfaces.bootstrap`, or the chain drops it. The `boot-plane` check fails if the chain admits ssh, NFS, Garage, an exporter or the Tinkerbell API, or if a host other than spore joins the VLAN.
- Traffic from spore's bootstrap address takes the routing table numbered `BOOTSTRAP_VLAN`, through a policy rule that systemd-networkd sets on the `bootstrap` interface from `talos-boot.nix`. The table holds the VLAN's own route and a default via the gateway, the first host in `BOOTSTRAP_CIDR`. A request that the gateway routes onto the VLAN from another network therefore passes the NixOS firewall's strict reverse-path filter, and its reply leaves on `bootstrap`.
- dnsmasq sends each TFTP transfer's data from port 69 (`tftp-single-port`), so a transfer is one UDP flow. A gateway reply rule matches only the request's port, so a transfer from a server-chosen port would not cross the gateway. The `boot-plane` and `spore-reliability` checks fail without the setting.
- A node on the Kubernetes network reaches spore through the gateway, whose policies `kubernetes_to_boot` admit `SPORE_BOOTSTRAP_IP` on TCP 80, 443, 7080 (Smee's script port, which spore's own firewall closes while Smee is off) and 42113 (the Tink server), and UDP 69, 123 and 514 (HookOS's syslog).
- The `boot-plane` and `spore-reliability` checks in `nix/lib/checks.nix` fail if dnsmasq could lease addresses or answer DHCP.

## Where it lives

- `nix/services/talos-boot.nix`: the VLAN, firewall, dnsmasq, nginx paths, the checks and the mirror
- `nix/services/fleetd.nix`: the enrollment name's listener and certificate, and the `netboot-not-allowed` links
- `nix/services/hookos-syslog.nix`: HookOS's syslog receiver
- `nix/services/tinkerbell.nix`: Tinkerbell, with Smee behind `homelab.tinkerbell.smee.enable`
- `clusters/folly/config/anchor-topology.json`: `BOOTSTRAP_CIDR`, `BOOTSTRAP_VLAN`, `SPORE_BOOTSTRAP_IP`
- `terraform/network/unifi/folly/bootstrap.tf`: the bootstrap network, the boot option and the switch ports
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
- [fleetd](../../apps/fleetd.md)
- [Netboot](netboot.md)
- [Lab DNS and time](../network/ingress-and-dns.md#lab-dns-and-time)
- [Provision a node](../../runbooks/provision-a-node.md)
- [Topology](../../reference/topology.md)
