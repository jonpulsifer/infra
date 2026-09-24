---
title: Network
description: The two sites, their UniFi gateways and networks, and the tunnel, routes, ingress and tailnet that connect them.
---

The network connects two sites, folly (home) and offsite (remote). Each site has a UniFi gateway, its own networks and one Kubernetes cluster. Each gateway runs a UniFi console, the web app that configures the site. folly's console calls offsite `nest`, and offsite's console calls folly `fml`.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| UniFi gateway | Routes and filters traffic, and exchanges routes with the cluster over BGP | UDM Pro at folly, UCG Max at offsite |
| [Site Magic tunnel](network/routing-and-firewall.md) | Carries traffic and routes between the sites over WireGuard (`wgsts1000`) | The two gateways |
| Cilium | Assigns pod and load-balancer addresses (VIPs), and announces them over BGP | Each Kubernetes node |
| [Ingress](network/ingress-and-dns.md) | Gives services DNS names, certificates and public reach | Each cluster |
| [Tailscale Connector](network/remote-access.md) | Routes Tailscale traffic into the site | Each cluster |
| [Lab resolvers](network/ingress-and-dns.md#lab-dns-and-time) | Serve lab DNS and NTP | [capsule](../hosts/capsule.md) and [spore](../hosts/spore.md) |

## Networks

| Site | Network | Job |
| --- | --- | --- |
| folly | Management | Home network, WLAN `fml` |
| folly | Lab Net | Lab hosts, WLAN `lab` (open, hidden) |
| folly | Kubernetes | folly nodes. DHCP offers iPXE netboot from spore. |
| folly | future | IPv6 prefix delegated from the WAN. Holds the Windows desktop tallboy. |
| folly | iot | IoT devices |
| offsite | Default | Client LAN |
| offsite | Kubernetes | offsite nodes |

## Rules

- Read addresses, subnets and ASNs from `cluster-topology.json` and `lab-topology.json`. Do not copy them.
- Change a subnet and every copy of it in one PR, or routes and DNS break. Find the copies with `git grep -nF '<old prefix>'`. They include the FRR files, `policy.hujson`, the Tailscale Connectors and VIPs pinned in app manifests.
- After a change to a node subnet, `future` or offsite's Default network, edit the Site Magic subnet list in both consoles, or the other site has no route to the subnet.
- Change a lab host address as the [Topology rules](../reference/topology.md#rules) say.

## Where it lives

- `terraform/network/unifi/<site>/`: networks and their VLAN IDs, WLANs, firewall and gateway BGP config. `terraform/network/unifi/folly/home.tf` and `terraform/network/unifi/offsite/networks.tf` hold the Management, iot and offsite Default subnets.
- Each console's UI: the Site Magic tunnel, its subnet lists and the console's Let's Encrypt certificate
- `clusters/<site>/config/cluster-topology.json`: `K8S_NODE_CIDR`, `LB_RANGE`, `ROUTER_IP` and the other cluster keys. Print them with `jq .data <file>`.
- `clusters/folly/config/lab-topology.json`: `LAB_CIDR`, `FUTURE_CIDR` and the lab host addresses

## Related

- [Inspect the UniFi network](../runbooks/inspect-the-unifi-network.md)
