---
title: Kea
description: The DHCP server on spore for folly's Kubernetes network, which leases the netboot pool and names the signed iPXE, through the gateway's relay.
---

Kea is the DHCPv4 server on [spore](../../hosts/spore.md) for folly's Kubernetes network. The UDM relays the network's DHCP to it (`dhcp_relay` in `terraform/network/unifi/folly/k8s.tf`), and it leases the netboot pool and tells PXE firmware where the signed iPXE is. The UDM's own DHCP for the network stays declared and disabled in the same file, the rollback. Smee's proxy offer, which raced the UDM's, is off.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| `kea-dhcp4-server` | Answers relayed DHCP on `SPORE_BOOTSTRAP_IP`, from a UDP socket, so a machine on the bootstrap VLAN itself hears nothing from it | spore |
| The pool | `K8S_DHCP_CIDR`, the first host to the last host but one, with a one-day lease: firmware PXE, HookOS and a fresh install's first boot | Kea |
| The boot file | `next-server` is spore's bootstrap address and `boot-file-name` is the signed iPXE under dnsmasq's TFTP root, for every client | Kea |
| Reservations | `/var/lib/kea/fleet/reservations.json`, a JSON array Kea splices into its subnet with an include directive. [fleetd](../../apps/fleetd.md) writes it each pass | spore |
| Control socket | `/run/kea/kea-dhcp4.socket`, for `config-reload` and statistics. Kea 3 accepts no other directory; the unit's umask and a tmpfiles rule on the directory let group `kea` connect | spore |
| `kea-check` | Exports `kea_dhcp4_serving` and `kea_dhcp4_acks_total` to the node exporter each minute | spore |

## Boot path

A machine on a node port broadcasts a DHCP request. The UDM forwards it to spore's bootstrap address with the network's router as the relay address, Kea picks the subnet from that address, and the answer goes back through the UDM: a pool address, the anchors' resolvers, and `SPORE_BOOTSTRAP_IP` with the signed iPXE as the boot file. The rest of the path is [Talos boot](talos-boot.md#boot-path): PXE firmware fetches the iPXE over TFTP, the iPXE fetches HookOS over HTTP, and HookOS attests against [fleetd](../../apps/fleetd.md).

## Reservations

Each pass, fleetd writes one reservation per NetBox device that has a MAC and an address: the MAC, the device's address and its name, and `boot-file-name` naming the signed iPXE while the device has an unfinished `Workflow`, the same condition that turns `allowPXE` on. It writes the file beside itself and renames it, then sends `config-reload` over the control socket and treats any result but 0 as the pass's error. An unchanged file sends no reload. An AMT, which shares its node's MAC, leases the node's address from this reservation. A MAC with no reservation gets a pool address and the global boot file, so an unknown machine still reaches iPXE's menu, which intake needs.

The directory `/var/lib/kea/fleet` is group-writable and setgid `kea`, and Kea's unit umask makes the control socket group-writable, so fleetd, in group `kea`, needs no privilege beyond that group.

## Rules

- Keep `dhcp-socket-type` at `udp`. A raw socket would answer a machine on the bootstrap VLAN directly, and the `boot-plane` check in `nix/lib/checks.nix` fails.
- Keep Kea on spore alone. The same check fails if another host enables it.
- Smee is off on spore. If it is turned back on while Kea is on, keep `homelab.tinkerbell.smee.dhcp` off: two servers would both answer the relay, and the `spore-reliability` check fails otherwise.
- Read the pool, the router and the DNS addresses from the topology files. The module computes the pool from `K8S_DHCP_CIDR` the way `k8s.tf` does.
- A broken `reservations.json` stops Kea from starting, and a reload Kea refuses is an error in fleetd's journal. The file is a JSON array; the module seeds `[]` when it is missing.
- Kea runs as the static user `kea`, not the NixOS module's dynamic one, so `/var/lib/kea` and `/run/kea` are plain directories that a process in group `kea` reaches. A dynamic user puts them behind `/var/lib/private`, which only root traverses.

## Alerts

| Alert | Meaning |
| --- | --- |
| `SporeKeaDown` | `kea-dhcp4-server` is not active on spore |

`clusters/folly/monitoring/spore.yaml` declares it.

## Where it lives

- `nix/services/kea.nix`: the module, the config, the check and the firewall port
- `nix/services/fleetd.nix` and `apps/fleetd/fleet/kea.go`: the reservations writer and the reload
- `nix/hosts/spore.nix`: `homelab.kea.enable`
- `nix/services/tinkerbell.nix`: Smee's DHCP switch
- `nix/lib/checks.nix`: the `boot-plane` and `spore-reliability` assertions
- `clusters/folly/config/cluster-topology.json`: `K8S_NODE_CIDR`, `K8S_DHCP_CIDR`, `ROUTER_IP`
- `clusters/folly/config/anchor-topology.json`: `SPORE_BOOTSTRAP_IP`, `NS1_IP`, `NS2_IP`
- `terraform/network/unifi/folly/k8s.tf`: the relay, and the UDM's disabled DHCP for the network

## Related

- [Talos boot](talos-boot.md)
- [Tinkerbell](tinkerbell.md)
- [Routing and firewall](../network/routing-and-firewall.md#dhcp-for-installation)
