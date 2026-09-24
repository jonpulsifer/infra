---
title: Network
description: The two sites, their UniFi gateways and networks, and the tunnel, routes, ingress and tailnet that connect them.
---

The network connects two sites: folly, the home site, and offsite, the remote site. Each site has a UniFi gateway, its own networks and one Kubernetes cluster. Every host, cluster and app gets its addresses, routes, DNS and ingress from it.

Each gateway runs a UniFi console, the web app that configures the site. The consoles name the sites differently. In folly's console and firewall policies, offsite is `nest`, and in offsite's console, folly is `fml`.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| UniFi gateway | Routes and filters traffic, and exchanges routes with the cluster over BGP, the protocol routers use to share routes | UDM Pro at folly, UCG Max at offsite |
| [Site Magic tunnel](network/routing-and-firewall.md) | Carries traffic and routes between the sites over the WireGuard tunnel `wgsts1000` | The two gateways |
| Cilium | Gives pods their addresses, gives Services and Gateways load-balancer addresses (VIPs), and announces both over BGP | Each Kubernetes node |
| [Ingress](network/ingress-and-dns.md) | Gives services DNS names, certificates and public reach | Each cluster |
| [Tailscale Connector](network/remote-access.md) | Routes traffic from the tailnet, the private Tailscale network, into the site | Each cluster |
| [Lab resolvers](network/ingress-and-dns.md#lab-dns-and-time) | Serve DNS with a blocklist, and NTP time, to the lab | [capsule](../hosts/capsule.md) and [spore](../hosts/spore.md) |

## Networks

| Site | Network | Job |
| --- | --- | --- |
| folly | Management | Home network, WLAN `fml` |
| folly | Lab Net | Lab hosts, WLAN `lab` (open, hidden SSID) |
| folly | Kubernetes | folly nodes. DHCP offers iPXE netboot from spore (`boot/ipxe.efi`). |
| folly | future | Gets an IPv6 prefix delegated from the WAN. The Windows desktop tallboy is on it. |
| folly | iot | IoT devices |
| offsite | Default | Client LAN |
| offsite | Kubernetes | offsite nodes |

Each network's VLAN ID is on its `unifi_network` resource in `terraform/network/unifi/<site>/`.

A firewall zone is a group of networks that the gateway filters as one. folly declares a custom `Lab` zone that holds Lab Net and Kubernetes. UniFi assigns every other network, iot included, to a built-in zone, and git does not declare those assignments. The firewall policies expect Management, future and offsite's Kubernetes network in the built-in `Internal` zone.

## Rules

- Read addresses, subnets and autonomous system numbers (ASNs) from `cluster-topology.json` and `lab-topology.json`, and do not copy them. Only the preconditions in the folly UniFi OpenTofu root, `terraform/network/unifi/folly/`, check a copy, so other copies drift without an error.
- Change a subnet and every copy of it in one PR. Find the copies in git with `git grep -nF '<old prefix>'`. Copies include the config of FRR, the routing daemon on each gateway, as well as `policy.hujson`, the Tailscale Connectors and VIPs pinned in app manifests. A missed copy breaks routes or DNS.
- After a change to a node subnet, `future` or offsite's Default network, edit the Site Magic subnet list in both consoles. The lists exist only in the console UI, so `git grep` cannot find them. A stale list leaves the other site with no Site Magic route to the subnet.
- Change a lab host address in `lab-topology.json` and `clients.yaml` in the same PR. If they disagree, a folly UniFi precondition fails the plan in Atlantis, the service that plans and applies OpenTofu on a PR.

## Where it lives

- `terraform/network/unifi/<site>/`: networks, WLANs, firewall and the gateway's BGP config. `terraform/network/unifi/folly/home.tf` and `terraform/network/unifi/offsite/networks.tf` hold the subnets of Management, iot and offsite's Default network. The `Teleport CIDR` group in `terraform/network/unifi/folly/firewall.tf` holds one more subnet.
- Each console's UI: the Site Magic tunnel, the subnets each site sends over it, and the console's certificate from UniFi OS's built-in Let's Encrypt support. No OpenTofu resource declares them.
- `clusters/<site>/config/cluster-topology.json`: cluster keys such as `K8S_NODE_CIDR`, `LB_RANGE` and `ROUTER_IP`. Print them with `jq .data <file>`.
- `clusters/folly/config/lab-topology.json`: `LAB_CIDR`, `FUTURE_CIDR` and the lab host addresses

## Related

- [Routing and firewall](network/routing-and-firewall.md)
- [Ingress and DNS](network/ingress-and-dns.md)
- [Remote access](network/remote-access.md)
- [Inspect the UniFi network](../runbooks/inspect-the-unifi-network.md)
