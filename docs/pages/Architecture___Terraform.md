icon:: 🌍
tags:: architecture

- **Layer 3.** All Terraform root modules live under `terraform/`; each is standalone. Applies run through **Atlantis** on the PR — never locally ([[ADR/0001 GitOps apply model]]).
- ## Network fabric — `terraform/network/`
	- `unifi/folly/` — primary-site UniFi: VLANs, BGP config, client management (state prefix `terraform/unifi`)
	- `unifi/offsite/` — offsite UniFi: networks, WANs, WLANs, BGP (state prefix `terraform/unifi/offsite`)
	- `cloudflare/` — DNS zones (pulsifer.ca, wishin.app, lolwtf.ca), tunnels, security rules, the Pages project behind this wiki
	- `tailscale/` — devices, routes, ACL policy
- ## Cloud & identity
	- `gcp/organization/` — org-level IAM, folders, projects, billing
	- `gcp/projects/<name>/` — per-project resources (homelab-ng, firebees, lolcorp, …)
	- `argo/` — ArgoCD application definitions
	- `google-workspace/` — users, groups, domains
	- OpenBao backing resources — GCP KMS in `gcp/projects/homelab-ng/`; the server's integrated Raft storage is Flux-managed
	- `modules/` — reusable modules consumed by relative path
- ## Workflow
	- Open a PR → Atlantis autoplans the changed module(s) → review the plan → comment `atlantis apply` → successful apply automerges.
	- Locally, only inspection:
	- ```bash
	  terraform init -backend=false && terraform validate
	  terraform fmt -recursive
	  ```
	- **Never `terraform apply` against remote state** — it races Atlantis and causes lock contention and drift.
	- Roots that need network facts read the SSOT: `jsondecode(file(".../cluster-topology.json")).data` via a `topology.tf` per root ([[ADR/0003 Cluster topology single source of truth]]).
- ## CI
	- `terraform.yml` validates changed `.tf` files on PRs, then auto-formats and regenerates terraform-docs on merge to `main`. `trivy.yml` scans for IaC vulnerabilities. Renovate bumps providers.
