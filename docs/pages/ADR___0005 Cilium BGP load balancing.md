status:: accepted
date:: 2025 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- Services need stable LoadBalancer VIPs reachable from the LAN and from the other site, without a cloud LB. The clusters already run Cilium as CNI, and the UniFi gateways speak BGP.
- # Decision
	- Use **Cilium's BGP control plane** as the load balancer: VIP pools are declared in `clusters/<site>/networking/cilium/ip-pools.yaml`, and Cilium advertises VIPs and pod CIDRs to the site gateway. iBGP between the two gateways (over the Site Magic tunnel) carries the routes cross-site.
	- Cross-site reachability is **gated by the gateway firewall, not the routing protocol**: each gateway must allow the full k8s address space (pod CIDRs + VIP pools, not just node subnets) to forward the routes it learns. folly enforces this with the custom `Lab` zone in `terraform/network/unifi/folly/firewall.tf`; offsite relies on the permissive default `Internal` zone.
- # Consequences
	- LB VIPs are plain routed IPs — no MetalLB, no ARP tricks, and the gateway's routing table shows exactly what's advertised.
	- Unreachable VIPs most often point to the gateway not programming the advertised BGP routes, or Tailscale hairpin interference — not the Cilium/kernel. Check those first; do not downgrade Cilium for this symptom.
	- Firewall changes are part of any address-space change; forgetting them breaks cross-site silently.
- # Links
	- [[Architecture/Networking]], [[ADR/0003 Cluster topology single source of truth]], `terraform/network/unifi/folly/README.md`
