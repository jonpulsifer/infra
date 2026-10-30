---
title: Routing and firewall
description: The BGP routes and zone firewall that connect the folly and offsite clusters through the UniFi gateways, and folly's node ports and boot network.
---

Cilium on each node announces the cluster's pod and load-balancer addresses (VIPs) over BGP to FRR on its site's UniFi gateway. The gateways share these routes through Site Magic, UniFi's WireGuard tunnel between them. Each gateway's zone firewall decides which cross-site traffic passes.

## Routes

Pods get addresses from `CILIUM_POD_CIDR`, and LoadBalancer Services and Gateways get VIPs from `LB_RANGE`. Each node opens an eBGP session with the gateway at `ROUTER_IP`. The gateway's `HOMELAB-IN` prefix-list accepts only the node subnet, VIP pool and pod pool.

The gateways exchange VIP pools and pod pools over iBGP through the tunnel, and folly also sends the Anchor network to offsite that way. Site Magic also runs OSPF for the subnets in each console's Site Magic list, and the OSPF route wins for them. folly lists its node subnet and `future`, and offsite lists its node subnet and Default. Neither protocol carries folly's Management or iot networks, and offsite sends traffic for an address it has no route to out its WAN.

## Firewall

The gateway filters traffic between zones, which are groups of networks declared in UniFi. A packet's source zone is the zone of the interface where it arrives. VIP pools and pod pools are in no zone.

folly holds the Anchor network and Kubernetes in a custom `Lab` zone. offsite has no custom policies, and the built-in rules between its `Internal` zone and `Vpn`, the tunnel's zone, allow cross-site traffic.

## Node ports

Every folly node port is a Kubernetes port: the network untagged, no tagged VLANs, and no 802.1X. `node_ports` in `terraform/network/unifi/folly/bootstrap.tf` names them: each [inventory](../../reference/inventory.md) node's `switch_port`, and `free_node_ports`, where a new box may be cabled. A node carries its address statically in its Talos config, so the switch needs no MAC and the gateway holds no reservation for it. A quarantine is the node's identity revoked and the node cordoned, with no VLAN move. [Identity](../identity.md) has the rules.

The Kubernetes network's DHCP pool is `K8S_DHCP_CIDR` in `clusters/folly/config/cluster-topology.json`, which holds no node's address. It serves machines that netboot: firmware PXE, HookOS, and an install's first boot before Talos applies its config. Its offer names the anchors' DNS addresses, whose CoreDNS answers `enroll.lolwtf.ca` with `BOOT_VIP`, and `BOOT_VIP` as its TFTP server with the signed iPXE as the boot file, `boot_option` in `bootstrap.tf`. [Talos boot](../nixos/talos-boot.md) serves the iPXE.

The `bootstrap` network holds the anchors' boot addresses and `BOOT_VIP`, with no DHCP. Its keys are `BOOTSTRAP_CIDR`, `BOOTSTRAP_VLAN`, `<HOST>_BOOTSTRAP_IP` and `BOOT_VIP` in `clusters/folly/config/anchor-topology.json`. Each anchor's switch port carries the VLAN tagged, and no port carries it untagged. The network is alone in the `Bootstrap` zone, whose policies block the gateway and every other address in `LB_RANGE`. The policies `kubernetes_to_boot` in `firewall.tf` admit the Kubernetes network to each anchor's bootstrap address and `BOOT_VIP` on the boot, enrollment and Tinkerbell ports, which the policy's comment lists. A reply rule matches only the policy's ports, so dnsmasq on the anchors sends TFTP data from port 69 as well. [Talos boot](../nixos/talos-boot.md#rules) says how the anchors answer.

## Rules

- A new node needs its `bgp-enabled` label, or it has no BGP session. Talos sets the label on folly's nodes, and `clusters/offsite/bootstrap/node-labels.tf` sets it on offsite's. folly's FRR file accepts a session from any address in `K8S_NODE_CIDR` with `bgp listen range`, which `bgp.tf` fills from the [topology file](../../reference/topology.md). FRR only listens for these peers, and Cilium on each node opens the session. offsite's FRR file needs a `neighbor <ip> peer-group HOMELAB` line for each node, where `<ip>` is the node's `NODE_ADDRESSES` value, copied by hand.
- After a topology change, edit the literal addresses in both FRR files, or the gateways drop the new routes. The Anchor network's prefix is `ANCHOR_CIDR` in `clusters/folly/config/anchor-topology.json`.
- The only tunnel traffic folly admits to an Anchor network host is from offsite's node subnet, VIP pool and pod pool to capsule: ssh on port 22 (policy `nest_k8s_to_capsule_ssh`) and the NetBox API on port 8080 (policy `nest_k8s_to_capsule_netbox`), so offsite reaches other the Anchor network hosts with capsule as an ssh jump host. offsite's Default network also routes to the Anchor network, and folly's `Vpn` to `Lab` chain drops it.
- In a folly policy that allows cross-site traffic, list the node subnet, VIP pool and pod pool as sources. Pod packets enter `Lab` on the node's interface, and the `Lab` to `Vpn` chain ends in a DROP.
- Keep the policy `folly_lb_to_nest_lan`, or replies from folly VIPs to offsite's Default network drop. folly pods and nodes cannot open connections to that network.
- Keep Management, `future` and offsite's Kubernetes network in `Internal`, where the policies expect them. If offsite's Kubernetes network moves to a custom zone, copy folly's cross-site policies to offsite.
- The gateway does not filter tunnel traffic to folly VIPs and pods, because the `Vpn` chain to the WAN accepts it. To restrict it, write a Cilium network policy.
- Intel AMT shares each AMT node's NIC and address, so no zone separates it from the Kubernetes VLAN. The cluster-wide Cilium policy `deny-pod-egress-to-amt` stops every pod on both clusters from reaching AMT's ports (TCP 16992–16995, 623 and 664) on any address. Host-network pods are not Cilium endpoints, so the policy does not cover them.
- A reinstall changes nothing on the network: the node netboots on the Kubernetes network.
- A `port_override` block replaces its port's whole override, and removing one does not reset the port.
- Apply a node's static address in `clusters/folly/talos` before a change that takes its address out of the Kubernetes network's DHCP, or the node can change address at its next lease renewal.

## Where it lives

- `clusters/<site>/config/cluster-topology.json`: `ROUTER_IP`, `BGP_CILIUM_ASN`, `BGP_GATEWAY_ASN`, `CILIUM_POD_CIDR` and `LB_RANGE`
- `clusters/folly/config/anchor-topology.json`: `ANCHOR_CIDR` and `CAPSULE_IP`
- `clusters/<site>/networking/cilium/`: the pod pool, VIP pool and BGP config
- `clusters/base/networking/cilium-policies/`: the cluster-wide policies both clusters run
- `terraform/network/unifi/folly/bgp-folly.conf` and `terraform/network/unifi/offsite/bgp.conf`: the FRR files
- `terraform/network/unifi/folly/firewall.tf`: the `Lab` and `Bootstrap` zones and their policies
- `terraform/network/unifi/folly/bootstrap.tf`: the bootstrap network, the boot option and the switch port overrides
- `terraform/network/unifi/folly/k8s.tf`: the Kubernetes network and its DHCP
- Each console's UI: the Site Magic tunnel and its subnet lists

## Related

- [Network](../network.md)
- [Inspect the UniFi network](../../runbooks/inspect-the-unifi-network.md)
