icon:: 🕸️
tags:: architecture

- Networking spans all four layers: UniFi VLANs and BGP at Layer 1/3 (`terraform/network/`), Cilium and the Gateway API inside each cluster at Layer 2 (`clusters/*/networking/`), Cloudflare and Tailscale gluing sites together at Layer 3. This page is the single place the whole story lives. Cluster composition is on [[Architecture/Kubernetes]]; host hardware is on [[Fleet]]; live discovery of the running UniFi controller is the `unifi-network` skill ([[Runbooks/Inspect UniFi Network]]).
- ## Sites and fabric
	- Two UniFi consoles, each its own Terraform root: `terraform/network/unifi/folly/` on-site and `terraform/network/unifi/offsite/` at the remote site. They're joined by exactly **one** inter-site data plane: a UniFi Site Magic WireGuard tunnel (`wgsts1000`).
	- Each site's k8s nodes run Cilium with a BGP control plane (ASN 64513) peering **eBGP** with that site's own UniFi gateway (ASN 64512) — folly's UDM Pro, offsite's UCG Max.
- ## LAN / VLANs
	- folly (`terraform/network/unifi/folly/`), all networks domain `lolwtf.ca` unless noted:
		- | network | VLAN | CIDR | notes |
		  | ---- | ---- | ---- | ---- |
		  | Management | — | `10.1.0.0/24` | domain `fml.pulsifer.ca`; WLAN `fml` (WPA3) |
		  | Lab Net | 2 | `10.2.0.0/24` | WLAN `lab` (open, hidden SSID); SSOT below |
		  | Kubernetes | 8 | `10.3.0.0/26` | node network; DHCP hands out iPXE boot info pointing at spore |
		  | future | 1337 | `10.13.37.0/28` | IPv6 PD enabled |
		  | iot | 666 | `10.66.6.0/26` | domain `iot.fml.pulsifer.ca` |
	- offsite (`terraform/network/unifi/offsite/`):
		- | network | VLAN | CIDR |
		  | ---- | ---- | ---- |
		  | Default | — | `192.168.1.0/24` |
		  | Kubernetes | 2 | `10.89.0.0/28` |
	- folly isolates Lab Net and Kubernetes together in a custom **`Lab`** firewall zone (`firewall.tf`); offsite's Kubernetes network sits in the default **`Internal`** zone — this split is the root of the cross-site reachability gap below.
	- Client MACs/DHCP reservations for both sites are declared in `terraform/network/unifi/folly/clients.yaml` (`cameras`, `unmanaged-infra`, `lab`, `k8s`, `rpis`, … groups) — point at that file rather than enumerating hosts here.
- ## Lab-network SSOT: `lab-topology`
	- `clusters/folly/config/lab-topology.json` **is** the flat-string Flux `lab-topology` ConfigMap. It owns the Lab/future CIDRs and the full host addresses consumed by NixOS, folly storage, and folly monitoring.
	- `nix/lib/lab.nix` projects the ConfigMap into the attribute shape host and service modules consume. The folly UniFi root reads it through `terraform/modules/cluster-topology`, preserving `local.lab` for network resources and deriving the gateway-host form of the future CIDR.
	- The `unifi_network.lab` precondition compares every selected ConfigMap host address with its `clients.yaml` DHCP-reservation octet. The ConfigMap owns full addresses; `clients.yaml` owns MACs and reservation octets; disagreement fails the Atlantis plan.
- ## Cluster network facts
	- The per-cluster `cluster-topology` ConfigMaps (`clusters/<site>/config/cluster-topology.json`) are the SSOT for every cluster network fact — full mechanism (Flux `substituteFrom`, `conftest` schema check, Nix/Terraform consumers) is on [[Architecture/Kubernetes]]. The current values:
	- | key | folly | offsite |
	  | ---- | ---- | ---- |
	  | `API_SERVER_IP` | `10.3.0.10` | `10.89.0.10` |
	  | `API_SERVER_HOSTNAME` | `folly.lolwtf.ca` | `offsite.lolwtf.ca` |
	  | `ROUTER_IP` | `10.3.0.1` | `10.89.0.1` |
	  | `K8S_NODE_CIDR` | `10.3.0.0/26` | `10.89.0.0/28` |
	  | `CILIUM_POD_CIDR` | `10.100.0.0/20` | `10.101.0.0/20` |
	  | `SERVICE_CIDR` | `10.10.0.0/16` | `10.11.0.0/16` |
	  | `CLUSTER_DNS` | `10.10.0.254` | `10.11.0.254` |
	  | `LB_RANGE` | `10.3.0.64/26` | `10.89.0.64/26` |
	  | `BGP_GATEWAY_ASN` | `64512` | `64512` |
	  | `BGP_CILIUM_ASN` | `64513` | `64513` |
- ## Cilium: CNI + BGP load balancer
	- `clusters/<site>/networking/cilium/ip-pools.yaml` declares a `CiliumPodIPPool` from `${CILIUM_POD_CIDR}` and a `CiliumLoadBalancerIPPool` from `${LB_RANGE}` with a catch-all `serviceSelector` — every Service/Gateway of type LoadBalancer gets a VIP from that pool.
	- `bgp.yaml` in the same directory sets up a `CiliumBGPClusterConfig` (nodes labelled `bgp-enabled: "true"` — every node in both clusters, per the Terraform bootstrap's `node-labels.tf`) peering to `${ROUTER_IP}` at `${BGP_GATEWAY_ASN}`, and two `CiliumBGPAdvertisement`s: pod IP pools, and Service addresses. **The two clusters advertise different address types** — folly advertises only `LoadBalancerIP`; offsite advertises `ClusterIP`, `ExternalIP`, and `LoadBalancerIP`.
	- On the gateway side, `unifi_bgp` (in each site's `bgp.tf`) uploads a raw FRR config file (`bgp-folly.conf` / `bgp.conf`) rather than using the provider's structured ASN/peer schema, because the config needs custom prefix-lists and route-maps the structured form can't express.
- ## Cross-site reachability
	- The single Site Magic tunnel carries two control-plane protocols, but both resolve through the *same* tunnel, so they are not independent paths:
		- **OSPF** (Site Magic's own) auto-shares the LAN/node subnets (`10.3.0.0/26` ⇄ `10.89.0.0/28`) and wins the RIB for them.
		- **iBGP between the gateways** (sourced from each gateway's LAN router-id via `update-source`, so sessions and reachability survive WAN failover) is the **only** way the Cilium LoadBalancer `/32` VIPs and pod CIDRs (`10.100.0.0/20` / `10.101.0.0/20`) cross sites at all — OSPF never carries them.
	- Because there's one tunnel, which protocol wins the RIB doesn't matter for reachability. What matters is the **gateway firewall**: it only forwards what it's told to allow across the `Lab`/`Internal` → `Vpn` forward.
	- folly isolates Lab Net + Kubernetes in a custom **`Lab`** zone (`firewall.tf`), so the cross-site allow policies (`nest_k8s_to_folly_k8s`, `folly_k8s_to_nest_k8s`) must explicitly list the **full k8s address space** — node CIDR, LB VIP pool, *and* pod CIDR — not just the node subnet. Matching only the node subnet was the actual cause of a real outage: node↔node traffic worked (node subnets were allowed) while pod-sourced packets got dropped on the `Lab → Vpn` forward.
	- offsite has **no custom firewall policies** at all — its Kubernetes network sits in the default `Internal` zone, whose predefined `Internal ⇄ Vpn` rules already permit the full k8s address space across the tunnel. If offsite's k8s network is ever moved into a custom/isolated zone, it needs folly's explicit pod-CIDR + VIP-pool allow policies mirrored, not just the node subnet.
- ## Gateway API ingress
	- Every cluster runs a shared `cluster-gateway` (`gatewayClassName: cilium`) serving `*.lolwtf.ca` off a cert-manager wildcard cert. Individual apps attach either as an extra listener on that shared Gateway (offsite's pattern — `dave`, `sonarr`, `radarr`, `prowlarr`, `bazarr`, `bittorrent` are all listeners on one `cluster-gateway`, one shared VIP) or as their own dedicated Gateway with its own VIP from the LB pool (folly's pattern — `jellyfin`, `hermes`, `dump`, `tronbyt`, `netbench` each get their own `Gateway` + `HTTPRoute`).
	- cert-manager (`clusters/*/networking/cert-manager/`) runs `letsencrypt-production` and `letsencrypt-staging` `ClusterIssuer`s using ACME DNS-01 against Cloudflare (API token from `cloudflare-secret.sops.yaml`), scoped to the cluster's secret domain and `${GATEWAY_ZONE}`.
- ## external-dns
	- `clusters/base/networking/external-dns/` runs external-dns against provider `cloudflare`, sourcing records from `crd`, `ingress`, and `gateway-httproute`, in `sync` policy with `txtOwnerId: ${CLUSTER_NAME}` (so folly and offsite don't fight over the same zone's TXT ownership records) and `domainFilters` scoped to the cluster's secret domain, `${GATEWAY_ZONE}`, and `${SPINDRIFT_DOMAIN}` — the App zone is in the filter, which is what lets an App's own HTTPRoute publish its name. Each cluster's overlay patches in `--fqdn-template={{.Name}}.${SECRET_DOMAIN}`.
	- Each cluster also ships a static `DNSEndpoint` CRD (`networking/external-dns/endpoints/gateway.yaml`) publishing `${GATEWAY_DOMAIN}` as an A record targeting every local VLAN gateway IP — all four (`10.1.0.1`, `10.2.0.1`, `10.3.0.1`, `10.13.37.1`) on folly, just `10.89.0.1` on offsite.
- ## Cloudflare Tunnel
	- The site tunnels run from the shared Deployment in `clusters/base/networking/cloudflare/`, with each overlay supplying its SOPS token. Their remotely managed ingress tables live with the tunnel resources in `terraform/network/cloudflare/lolwtf.ca.tf`.
	- Spindrift has a separate remotely managed wildcard tunnel in `terraform/network/cloudflare/spindrift.tf`. Its hardened edge Deployment runs on offsite from `clusters/offsite/networking/cloudflare/`; Terraform escrows the generated credential directly into 1Password and External Secrets delivers it to the pod.
	- Generated App names under `lolwtf.dev` are published by external-dns from each App's own HTTPRoute: an unproxied A record at the App Gateway's load-balancer address for a private reach, a proxied CNAME at the Spindrift tunnel for a public one. The App zone has its own `spindrift-apps` Gateway on its own pinned address, carrying the wildcard `*.lolwtf.dev` TLS listener — which is why generated names are flat, since a wildcard certificate binds one label. A routed Component also needs the chart's `CiliumNetworkPolicy` admitting the `ingress` identity: the gateway's data plane is the host-networked `cilium-envoy` DaemonSet, so no namespace selector reaches it. [[Architecture/Spindrift]] covers the reach and auth semantics.
	- A proxied wildcard CNAME still answers for every name in `lolwtf.dev`, and a Cloudflare Access application still covers it. Both are Terraform's: the tunnel module mints one DNS record per ingress hostname, so the wildcard routing rule the tunnel needs and the wildcard record that claims the whole zone are a single decision today. They are retired once Apps are observed publishing their own records.
	- Other cluster apps exposed through Gateway API and external-dns retain their private Cilium LB records and LAN/tailnet reachability. The site offsite tunnel also routes Atlantis's webhook hostname.
- ## Tailscale
	- `terraform/network/tailscale/` manages the `pirate-musical.ts.net` tailnet: devices, the ACL policy (`policy.hujson`), and a federated OIDC identity that lets the `nixos-deploy` GitHub Actions workflow join as `tag:ci` (scoped by the ACL to SSH into `tag:pi4` only, no long-lived secret).
	- Forge enrolls with an independently revocable OAuth client restricted to `tag:lab-host`. Terraform escrows the long-lived client secret in 1Password; Forge consumes an encrypted copy through its SSH-host-key-scoped SOPS file.
	- In-cluster, `clusters/base/networking/tailscale/` runs the `tailscale-operator` HelmRelease; each cluster's `tailscale-connectors/connector.yaml` deploys a subnet-router `Connector` advertising that site's LAN CIDRs plus `${K8S_NODE_CIDR}` and `${LB_RANGE}` — folly's connector also advertises `10.1.0.0/24` and `10.2.0.0/24`, offsite's advertises `192.168.1.0/24`.
	- The k8s node hosts themselves run **no** Tailscale client — `nix/system/tailscale-disable.nix` force-disables `services.tailscale`, and it's imported by all five k8s hosts (`optiplex`, `riptide`, `shale`, `oldschool`, `retrofit`) inline in `flake.nix`. Tailnet reachability into the clusters goes entirely through the Connector subnet router, not per-node clients.
	- `policy.hujson`'s `grants` explicitly permit `tag:folly` → offsite's k8s nodes/LB/LAN and `tag:offsite` → folly's k8s nodes/LB, plus `autoApprovers.routes` that auto-accept the Connectors' advertised CIDRs without manual review.
- ## DNS
	- `capsule` and `spore` run the shared CoreDNS sinkhole policy from `nix/services/coredns-sinkhole.nix`, forwarding over TLS to Cloudflare's malware-filtering resolvers. Their machine records are `capsule.lolwtf.ca` and `spore.lolwtf.ca`; `dns.lolwtf.ca` publishes both as the stable DNS service.
	- The immutable hosts policy is loaded without polling, and CoreDNS keeps no query database or query log. Its Prometheus endpoint provides aggregate request, response-code, cache, latency, upstream-health, and hosts-entry metrics; it does not provide Pi-hole-style per-query blocked/client analytics.
	- `capsule` and `spore` run the redundant Chrony service described on their fleet pages. `time.lolwtf.ca` publishes both hosts as the stable NTP service name.
	- Cloudflare zones, records, Access policy, and tunnels are declared under `terraform/network/cloudflare/`. Generated Spindrift names use the dedicated `lolwtf.dev` zone; ordinary lab and cluster names use `lolwtf.ca`.
	- LAN and cluster hosts resolve as `<host>.lolwtf.ca` — static A records come from `k8s.tf` (`k8s`, `optiplex`, `riptide`, `shale`, `nuc`, `erx`) and `lolwtf.ca.tf` (every `lab`/`rpis` client in `clients.yaml`), plus the per-cluster API-server and gateway records above. Reaching offsite hosts from off-net requires the tailnet.
- ## Known gaps
	- The FRR `*.conf` files (`bgp-folly.conf`, `bgp.conf`) hold their prefix-lists as hardcoded CIDR literals, not `${...}`-interpolated from the topology JSON — `unifi_bgp.config` is a raw `file()` read with no templating, so a CIDR change in `cluster-topology.json` has to be hand-copied into the matching `ip prefix-list` lines on both sites.
	- `terraform/network/tailscale/policy.hujson` hardcodes the same subnet and VIP-pool CIDRs in `autoApprovers.routes`, `ipsets`, and `tests` — HuJSON has no variable substitution, so this file can't reference the topology SSOT even in principle; it has to be hand-kept in sync.
