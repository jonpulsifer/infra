icon:: 🕸️
tags:: architecture

- The network spans two physical sites (folly and offsite) joined by a UniFi Site Magic tunnel, with Cloudflare in front of anything public and Tailscale for remote access.
- ## Single source of truth
	- All cluster network facts — node/API IPs, pod CIDRs, BGP ASNs and peer addresses, DNS — live in per-cluster `cluster-topology` ConfigMaps at `clusters/<site>/config/cluster-topology.json`. Flux substitutes them, Nix parses them, Terraform `jsondecode`s them. **Do not hardcode network facts anywhere else.** Details in [[ADR/0003 Cluster topology single source of truth]].
	- Not yet migrated: the FRR `*.conf` BGP files and `terraform/network/tailscale/policy.hujson` still hold literals.
- ## On-site fabric (UniFi)
	- `terraform/network/unifi/folly/` manages VLANs, BGP, and clients at the primary site; `terraform/network/unifi/offsite/` manages the offsite network. Read-only live discovery is available via the `unifi-network` skill.
- ## Load balancing (Cilium BGP)
	- Cilium advertises LoadBalancer VIPs (pools in `clusters/<site>/networking/cilium/ip-pools.yaml`) and pod CIDRs to the site gateway over BGP — [[ADR/0005 Cilium BGP load balancing]].
- ## Cross-site reachability
	- folly ⇄ offsite k8s traffic rides the single Site Magic tunnel. iBGP between the gateways carries the routes, but **the gateway firewall is the actual gate**: a gateway only forwards the pod CIDRs and VIP pools if its firewall allows the full k8s address space, not just node subnets.
	- folly enforces this with a custom `Lab` zone in `terraform/network/unifi/folly/firewall.tf`; offsite uses the permissive default `Internal` zone.
- ## Ingress and tunnels
	- The Gateway API `cluster-gateway` handles in-cluster ingress; Cloudflare Tunnels (`terraform/network/cloudflare/`) are the external entry points — one per site (`folly`, `offsite`, e.g. Atlantis at `tf.lolwtf.ca` rides the offsite tunnel).
	- external-dns publishes records; DNS zones (pulsifer.ca, wishin.app, lolwtf.ca) are Terraform-managed.
- ## Remote access
	- Tailscale (`terraform/network/tailscale/`) provides the overlay: devices, routes, and the ACL policy. k8s nodes have Tailscale disabled (`tailscale-disable.nix`); the Pis and edge hosts run it.
	- LAN hosts resolve as `<host>.lolwtf.ca`; reaching offsite from off-net requires the tailnet.
