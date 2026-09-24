---
title: Routing and firewall
description: The BGP routes and zone firewall that connect the folly and offsite clusters through the UniFi gateways.
---

Cilium on each node announces the cluster's pod and load-balancer addresses (VIPs) over BGP to FRR on its site's UniFi gateway. The gateways share these routes through Site Magic, UniFi's WireGuard tunnel between them. Each gateway's zone firewall decides which cross-site traffic passes.

## Routes

Pods get addresses from `CILIUM_POD_CIDR`, and LoadBalancer Services and Gateways get VIPs from `LB_RANGE`. Each node opens an eBGP session with the gateway at `ROUTER_IP`. The gateway's `HOMELAB-IN` prefix-list accepts only the node subnet, VIP pool and pod pool.

The gateways exchange VIP pools and pod pools over iBGP through the tunnel. Site Magic also runs OSPF for the subnets in each console's Site Magic list, and the OSPF route wins for them. folly lists its node subnet and `future`, and offsite lists its node subnet and Default. Neither protocol carries folly's Management, Lab Net or iot networks.

## Firewall

The gateway filters traffic between zones, which are groups of networks declared in UniFi. A packet's source zone is the zone of the interface where it arrives. VIP pools and pod pools are in no zone.

folly holds Lab Net and Kubernetes in a custom `Lab` zone. offsite has no custom policies, and the built-in rules between its `Internal` zone and `Vpn`, the tunnel's zone, allow cross-site traffic.

## Rules

- A new node needs its `bgp-enabled` label in `clusters/<site>/bootstrap/node-labels.tf` and a `neighbor <ip> peer-group HOMELAB` line in its site's FRR file, or it has no BGP session.
- After a topology change, edit the literal addresses in both FRR files, or the gateways drop the new routes.
- In a folly policy that allows cross-site traffic, list the node subnet, VIP pool and pod pool as sources. Pod packets enter `Lab` on the node's interface, and the `Lab` to `Vpn` chain ends in a DROP.
- Keep the policy `folly_lb_to_nest_lan`, or replies from folly VIPs to offsite's Default network drop. folly pods and nodes cannot open connections to that network.
- Keep Management, `future` and offsite's Kubernetes network in `Internal`, where the policies expect them. If offsite's Kubernetes network moves to a custom zone, copy folly's cross-site policies to offsite.
- The gateway does not filter tunnel traffic to folly VIPs and pods, because the `Vpn` chain to the WAN accepts it. To restrict it, write a Cilium network policy.

## Where it lives

- `clusters/<site>/config/cluster-topology.json`: `ROUTER_IP`, `BGP_CILIUM_ASN`, `BGP_GATEWAY_ASN`, `CILIUM_POD_CIDR` and `LB_RANGE`
- `clusters/<site>/networking/cilium/`: the pod pool, VIP pool and BGP config
- `terraform/network/unifi/folly/bgp-folly.conf` and `terraform/network/unifi/offsite/bgp.conf`: the FRR files
- `terraform/network/unifi/folly/firewall.tf`: the `Lab` zone and cross-site policies
- Each console's UI: the Site Magic tunnel and its subnet lists

## Related

- [Network](../network.md)
- [Inspect the UniFi network](../../runbooks/inspect-the-unifi-network.md)
