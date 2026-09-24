---
title: Routing and firewall
description: The BGP routes and zone firewall that connect the folly and offsite clusters through the UniFi gateways.
---

Cilium announces each cluster's pod and load-balancer addresses to its site's UniFi gateway, and the gateways share them through the Site Magic tunnel. The gateway firewall decides which cross-site traffic passes. Every connection between folly and offsite depends on both.

BGP is the protocol that routers use to tell each other which addresses they reach. The Site Magic tunnel is UniFi's WireGuard tunnel between the two gateways.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Cilium BGP | Announces pod addresses and load-balancer addresses (VIPs) to the gateway | Each Kubernetes node |
| FRR | Accepts the cluster's routes and shares them with the other site. FRR is the routing daemon on the gateway. | Each gateway |
| Site Magic tunnel | Carries traffic and routes between the sites | The two gateways |
| Zone firewall | Decides which traffic passes between groups of networks | Each gateway |

## Routes

Pods get addresses from the pod pool (`CILIUM_POD_CIDR`). Every LoadBalancer Service and Gateway gets a VIP from the VIP pool (`LB_RANGE`).

Cilium on each node opens an external BGP (eBGP) session with the site gateway at `ROUTER_IP`. Each side has an autonomous system number (ASN), `BGP_CILIUM_ASN` for the nodes and `BGP_GATEWAY_ASN` for the gateway.

Both clusters announce their pod pools. folly announces its VIPs, and offsite announces its VIPs, ClusterIPs and ExternalIPs. The gateway's `HOMELAB-IN` prefix-list, its filter for routes from the nodes, accepts only the node subnet, VIP pool and pod pool. offsite's announcements outside those ranges go no further than the gateway.

The two gateways run an internal BGP (iBGP) session through the Site Magic tunnel. That session carries the VIP pools and pod pools between the sites.

Site Magic also runs OSPF, a second routing protocol, for the subnets listed in each gateway's Site Magic settings. For those subnets, the gateway uses the OSPF route in place of the BGP route. folly lists its node subnet and `future`, and offsite lists its node subnet and Default. Neither OSPF nor iBGP carries folly's Management, Lab Net or iot networks.

The Site Magic settings exist only in the UniFi console, the web app that configures each gateway. No file in git declares them.

## Firewall

The gateway filters traffic by zone, a group of networks. Each pair of zones has its own chain of firewall rules. The gateway takes the source zone from the interface where the packet arrives, and the destination zone from the destination network.

A zone holds only networks declared in UniFi, so the VIP pools and pod pools are in no zone. Traffic to them uses the source zone's chain to the WAN, which accepts it.

folly holds Lab Net and Kubernetes in a custom `Lab` zone. offsite has no custom policies. Its Kubernetes network is in UniFi's built-in `Internal` zone. The built-in rules between `Internal` and `Vpn`, the zone that holds the Site Magic tunnel, allow cross-site traffic.

## Rules

- A new node needs its `bgp-enabled` label in `clusters/<site>/bootstrap/node-labels.tf` and a `neighbor <ip> peer-group HOMELAB` line in its site's FRR file. Without both, the node has no BGP session, and the gateway never learns its pod addresses.
- In a folly firewall policy that allows cross-site traffic, list the node subnet, VIP pool and pod pool as sources. A pod's packet enters the `Lab` zone on its node's interface, and the chain from `Lab` to `Vpn` ends in a DROP.
- Keep the firewall policy `folly_lb_to_nest_lan`, whose one source is the VIP pool. Without it, replies from folly VIPs to offsite's Default network drop. folly pods and nodes cannot open connections to that network.
- If offsite's Kubernetes network moves to a custom zone, copy folly's cross-site policies to offsite. The built-in `Internal` rules do not cover a custom zone.
- To restrict tunnel traffic to folly VIPs and pods, write a Cilium network policy. The gateway does not filter that traffic, because the `Vpn` zone's chain to the WAN accepts it.
- The FRR files hold literal addresses in their neighbor lists and prefix-lists. After a topology change, edit both files, or the gateways drop the new routes. Atlantis, the service that runs OpenTofu on a PR, plans an edit to a `.conf` file.

## Where it lives

- `clusters/<site>/config/cluster-topology.json`: `ROUTER_IP`, `BGP_CILIUM_ASN`, `BGP_GATEWAY_ASN`, `CILIUM_POD_CIDR` and `LB_RANGE`
- `clusters/<site>/networking/cilium/`: the pod pool, the VIP pool and the BGP config
- `clusters/<site>/bootstrap/node-labels.tf`: the `bgp-enabled` node labels
- `terraform/network/unifi/folly/bgp-folly.conf` and `terraform/network/unifi/offsite/bgp.conf`: FRR config for each gateway
- `terraform/network/unifi/folly/firewall.tf`: the `Lab` zone and the cross-site policies
- Each console's UI: the Site Magic tunnel and its subnet lists

## Related

- [Network](../network.md)
- [Inspect the UniFi network](../../runbooks/inspect-the-unifi-network.md)
