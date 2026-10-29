---
title: Routing and firewall
description: The BGP routes and zone firewall that connect the folly and offsite clusters through the UniFi gateways, and the MAC-auth gate on folly's bootstrap VLAN.
---

Cilium on each node announces the cluster's pod and load-balancer addresses (VIPs) over BGP to FRR on its site's UniFi gateway. The gateways share these routes through Site Magic, UniFi's WireGuard tunnel between them. Each gateway's zone firewall decides which cross-site traffic passes.

## Routes

Pods get addresses from `CILIUM_POD_CIDR`, and LoadBalancer Services and Gateways get VIPs from `LB_RANGE`. Each node opens an eBGP session with the gateway at `ROUTER_IP`. The gateway's `HOMELAB-IN` prefix-list accepts only the node subnet, VIP pool and pod pool.

The gateways exchange VIP pools and pod pools over iBGP through the tunnel, and folly also sends the Anchor network to offsite that way. Site Magic also runs OSPF for the subnets in each console's Site Magic list, and the OSPF route wins for them. folly lists its node subnet and `future`, and offsite lists its node subnet and Default. Neither protocol carries folly's Management or iot networks, and offsite sends traffic for an address it has no route to out its WAN.

## Firewall

The gateway filters traffic between zones, which are groups of networks declared in UniFi. A packet's source zone is the zone of the interface where it arrives. VIP pools and pod pools are in no zone.

folly holds the Anchor network and Kubernetes in a custom `Lab` zone. offsite has no custom policies, and the built-in rules between its `Internal` zone and `Vpn`, the tunnel's zone, allow cross-site traffic.

## Bootstrap VLAN and MAC auth

The `bootstrap` network is folly's quarantine VLAN for machines that RADIUS does not know and for nodes that NetBox marks `failed`. Its keys are `BOOTSTRAP_CIDR`, `BOOTSTRAP_VLAN`, `<HOST>_BOOTSTRAP_IP` and `BOOT_VIP` in `clusters/folly/config/anchor-topology.json`. UniFi DHCP names the anchors as its resolvers, whose CoreDNS answers `enroll.lolwtf.ca` with `BOOT_VIP`, and `BOOT_VIP` as its NTP, TFTP and boot server, which points PXE firmware at the signed iPXE that [Talos boot](../nixos/talos-boot.md) serves. Each anchor's switch port carries the VLAN tagged.

The network is alone in the `Bootstrap` zone. Its policies admit DHCP to the gateway and TCP 443 to `ENROLL_VIP` in `clusters/folly/config/cluster-topology.json`, the pinned address of the enrollment server's Gateway, which serves `enroll.lolwtf.ca`. They block the rest of the gateway and every other address in `LB_RANGE`. The internet stays open, so a Talos install can pull its installer image, and the zone's defaults block the LAN, the Anchor network and the Kubernetes VLAN. Traffic to the anchors stays on the VLAN, where the gateway does not filter it, so each anchor's own firewall admits only the boot, DNS and NTP services from the VLAN. [Talos boot](../nixos/talos-boot.md#rules) lists them.

Each node in the [hardware inventory](../../reference/inventory.md) has a RADIUS user on the gateway's built-in RADIUS server, in `terraform/network/unifi/folly/bootstrap.tf`, when its status is `planned`, `staged`, `active` or `failed` and it has a MAC and a switch port. The user's VLAN is the Kubernetes network, or bootstrap while the node's status is `failed`, which talos-attest sets when it quarantines a node. That quarantine moves only a port that runs MAC auth. `mab_enforced` in the same file names the nodes whose port runs MAC auth: riptide today, so switch-wide 802.1X is on, port 8 is on the `MAC auth` port profile, which authenticates each MAC (MAB) against RADIUS, and port 10 stays an open Kubernetes trunk until optiplex is added. The gateway's RADIUS server must listen first. With MAC auth on, RADIUS rejects an unknown MAC, and the switch puts it on the switch-wide fallback network, `bootstrap` (`dot1x_fallback_networkconf_id` in the console's switch settings). No machine outside the inventory has tested this on a MAC-auth port yet: The switch asks RADIUS at link-up and re-authenticates each MAC about once a minute, so a change to a user moves the port within a minute or two, with no link flap. riptide's port 8 shows this.

A known node also netboots on the Kubernetes network. Its DHCP carries the bootstrap network's boot option, `boot_option` in `bootstrap.tf`, and names the anchors' DNS addresses, whose CoreDNS answers `enroll.lolwtf.ca` with `BOOT_VIP` on every listener. The policies `kubernetes_to_boot` in `firewall.tf` admit the Kubernetes network to each anchor's bootstrap address and `BOOT_VIP` on the boot, enrollment and Tinkerbell ports, which the policy's comment lists. A reply rule matches only the policy's ports, so dnsmasq on the anchors sends TFTP data from port 69 as well. [Talos boot](../nixos/talos-boot.md#rules) says how the anchors answer.

The switch-wide 802.1X fallback, `bootstrap`, holds a MAC that RADIUS does not know, and a `failed` node's RADIUS user puts it there too. `spare_ports` in `bootstrap.tf`, the rack ports of new nodes, are on the `MAC auth` profile, so a new machine lands on bootstrap until its export is applied, and a node whose RADIUS user exists, planned ones included, lands on Kubernetes. A spare port that the inventory names takes that node's override instead. The prep station's port, `provisioning` in `quarantine_ports`, is always bootstrap: a static native network with no 802.1X, declared machine or not. The whole intake (key enrollment, attest, install and first boot) runs there before the machine moves to its rack port.

A MAC can be copied, so MAC auth sorts machines and does not authenticate them. Secure Boot and the TPM-sealed disks are the lock. The gate keeps an unknown machine off the Kubernetes VLAN, the Anchor network and the LAN.

## Rules

- A new node needs its `bgp-enabled` label, or it has no BGP session. Talos sets the label on folly's nodes, and `clusters/offsite/bootstrap/node-labels.tf` sets it on offsite's. folly's FRR file accepts a session from any address in `K8S_NODE_CIDR` with `bgp listen range`, which `bgp.tf` fills from the [topology file](../../reference/topology.md). FRR only listens for these peers, and Cilium on each node opens the session. offsite's FRR file needs a `neighbor <ip> peer-group HOMELAB` line for each node, where `<ip>` is the node's `NODE_ADDRESSES` value, copied by hand.
- After a topology change, edit the literal addresses in both FRR files, or the gateways drop the new routes. The Anchor network's prefix is `ANCHOR_CIDR` in `clusters/folly/config/anchor-topology.json`.
- The only tunnel traffic folly admits to an Anchor network host is ssh from offsite's node subnet, VIP pool and pod pool to capsule's port 22 (policy `nest_k8s_to_capsule_ssh`), so offsite reaches other the Anchor network hosts with capsule as an ssh jump host. offsite's Default network also routes to the Anchor network, and folly's `Vpn` to `Lab` chain drops it.
- In a folly policy that allows cross-site traffic, list the node subnet, VIP pool and pod pool as sources. Pod packets enter `Lab` on the node's interface, and the `Lab` to `Vpn` chain ends in a DROP.
- Keep the policy `folly_lb_to_nest_lan`, or replies from folly VIPs to offsite's Default network drop. folly pods and nodes cannot open connections to that network.
- Keep Management, `future` and offsite's Kubernetes network in `Internal`, where the policies expect them. If offsite's Kubernetes network moves to a custom zone, copy folly's cross-site policies to offsite.
- The gateway does not filter tunnel traffic to folly VIPs and pods, because the `Vpn` chain to the WAN accepts it. To restrict it, write a Cilium network policy.
- Intel AMT shares each AMT node's NIC and address, so no zone separates it from the Kubernetes VLAN. The cluster-wide Cilium policy `deny-pod-egress-to-amt` stops every pod on both clusters from reaching AMT's ports (TCP 16992–16995, 623 and 664) on any address. Host-network pods are not Cilium endpoints, so the policy does not cover them.
- Add a node to `mab_enforced` only in its own change, after the gateway's RADIUS server listens on port 1812 (over SSH, `ss -lunp` names a `freeradius` process; it is no systemd unit there), both RADIUS users exist, and the Default RADIUS profile has RADIUS-assigned VLAN on for wired networks. The API refuses writes to that profile, so the owner sets it once in the console under Settings, Profiles, RADIUS. The switch-wide 802.1X fallback network is `bootstrap`, set in the console because the provider has no field for it, so a MAC that RADIUS rejects or cannot answer lands on the bootstrap VLAN.
- A reinstall changes nothing on the network: the node netboots on the Kubernetes network.
- To open a port again, remove its node from `mab_enforced` in `bootstrap.tf`. Removing a `port_override` block does not reset a port.
- A MAC-auth port whose link flaps while the gateway's RADIUS server is down stays closed. optiplex is folly's only control plane.
- The `Bootstrap` zone reaches spore, DHCP on the gateway, `ENROLL_VIP` on TCP 443, and the internet for the installer image pull. It reaches nothing else on the LAN or in `LB_RANGE`. Two networks reach into it. The Kubernetes network reaches the anchors' boot services (policies `kubernetes_to_boot`). The `future` network reaches TCP 16992–16995, so MeshCommander keeps the Intel AMT console of a machine on the fallback, since AMT follows the machine's MAC onto the bootstrap VLAN (policy `future_to_bootstrap_amt`). Keep the enrollment server's Gateway at `ENROLL_VIP`, and keep each block policy ordered after its allow with `depends_on`.

## Where it lives

- `clusters/<site>/config/cluster-topology.json`: `ROUTER_IP`, `BGP_CILIUM_ASN`, `BGP_GATEWAY_ASN`, `CILIUM_POD_CIDR` and `LB_RANGE`
- `clusters/folly/config/anchor-topology.json`: `ANCHOR_CIDR` and `CAPSULE_IP`
- `clusters/<site>/networking/cilium/`: the pod pool, VIP pool and BGP config
- `clusters/base/networking/cilium-policies/`: the cluster-wide policies both clusters run
- `terraform/network/unifi/folly/bgp-folly.conf` and `terraform/network/unifi/offsite/bgp.conf`: the FRR files
- `terraform/network/unifi/folly/firewall.tf`: the `Lab` and `Bootstrap` zones and their policies
- `terraform/network/unifi/folly/bootstrap.tf`: the bootstrap network, the boot option, the RADIUS users and the switch port overrides
- `terraform/network/unifi/folly/k8s.tf`: the Kubernetes network and its DHCP
- Each console's UI: the Site Magic tunnel and its subnet lists

## Related

- [Network](../network.md)
- [Inspect the UniFi network](../../runbooks/inspect-the-unifi-network.md)
