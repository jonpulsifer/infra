status:: accepted
date:: 2026 (backfilled 2026-07-08)
deciders:: [[jawn]]
tags:: adr

- # Context
	- Cluster IPs, CIDRs, BGP ASNs, and API endpoints were duplicated across Flux manifests, Nix modules, and Terraform roots. Renumbering anything meant a scavenger hunt, and the copies drifted.
- # Decision
	- Per-cluster **`cluster-topology` ConfigMaps** at `clusters/<site>/config/cluster-topology.json` are the single source of truth for network facts. Each JSON file **is** the Flux ConfigMap (JSON is valid YAML, applied as-is) — no generator.
	- Consumers read it, never copy it:
		- Flux substitutes `${VAR}` via `postBuild.substituteFrom`
		- Nix reads it with `builtins.fromJSON` (`nix/services/k8s/networks.nix`)
		- Terraform roots read it with `jsondecode(file(...)).data` via a `topology.tf` each
- # Consequences
	- Renumbering is one file per cluster; every layer picks it up on its normal apply path.
	- `data` must stay flat `string→string` (a Flux `substituteFrom` requirement), so lists and numbers are encoded as strings (`CLUSTER_DNS` comma-separated, `API_SERVER_PORT` parsed to int in Nix).
	- Hardcoding a network fact anywhere else is now a review-blocking bug.
	- Not yet migrated: the FRR `*.conf` BGP files and `terraform/network/tailscale/policy.hujson` still hold literals.
- # Links
	- [[Architecture/Networking]], [[Architecture/Kubernetes]], [[Architecture/Terraform]]
