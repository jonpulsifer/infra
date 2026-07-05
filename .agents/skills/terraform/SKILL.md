---
name: terraform
description: >-
  Work with Terraform modules in this infra repo. All root modules live under
  terraform/: cloud/identity (gcp, argo, google-workspace, vault) and network
  fabric under terraform/network/ (unifi/folly, unifi/offsite, cloudflare, tailscale).
  Covers workflow, CI behaviour, and module layout.
---

## Module Layout

All Terraform roots live under `terraform/`, split by domain into network fabric
(`terraform/network/`) and cloud/identity. Each subdirectory below is an independent
root module with its own state:

```
# network fabric — terraform/network/
terraform/network/unifi/folly/    # primary-site UniFi: VLANs, BGP, clients
terraform/network/unifi/offsite/  # offsite UniFi: networks, WANs, WLANs, BGP
terraform/network/cloudflare/     # DNS, tunnels, security rules
terraform/network/tailscale/      # devices, routes, ACL policy

# cloud & identity — terraform/
terraform/gcp/organization/       # org-level IAM, folders, billing
terraform/gcp/projects/<name>/    # per-project resources
terraform/argo/                   # ArgoCD application definitions
terraform/google-workspace/       # Workspace users, groups, domains
terraform/vault/                  # Vault auth, mounts, policies
terraform/modules/                # reusable modules consumed via relative paths

# Flux bootstrap (Terraform, colocated with each cluster)
clusters/folly/bootstrap/         # Flux bootstrap for the folly cluster
clusters/offsite/bootstrap/       # Flux bootstrap for the offsite cluster
```

> The `terraform/network/` roots keep their original GCS state prefixes (`terraform/unifi`,
> `terraform/unifi/offsite`, `terraform/cloudflare`, `terraform/tailscale`) so the
> directory move needed no state migration — backend `prefix` intentionally differs
> from the path.

## Standard Workflow

Applies run through **Atlantis on the PR**, not locally. Open a PR with your `.tf`
changes; Atlantis autoplans on the changed module(s). Review the plan comment, then
comment `atlantis apply` — a successful apply automerges the PR.

```bash
cd terraform/<module-dir>
terraform init
terraform plan     # local inspection only
```

Do **not** run `terraform apply` against remote state — it races Atlantis and causes
state lock contention / drift. CI (`terraform.yml`) only validates; Atlantis is the
only thing that applies. See `kubernetes-gitops` for the Atlantis ↔ ArgoCD auth and
token-rotation details.

## Validation (no backend)

```bash
terraform init -backend=false
terraform validate
```

## Formatting

CI auto-formats and commits on merge to `main`. Run locally before committing:

```bash
terraform fmt -recursive
```

## CI Behaviour

- **On PR**: validates all changed `*.tf` directories in a matrix job.
- **On merge to `main`**: auto-formats and commits (`style: format terraform files`), then regenerates terraform-docs (`docs: regenerate terraform documentation`).
- Do not manually commit formatting fixes — CI handles it.

## Notes

- Terraform state is remote; `.tfstate` files are gitignored.
- `terraform/gcp/organization/` manages the GCP org hierarchy — changes affect all projects.
- `terraform/network/cloudflare/` Tunnel modules control external ingress for folly and offsite clusters.
- `terraform/modules/` are reusable (no backend); root modules reference them via relative paths (e.g. homelab-ng → `../../../modules/gce-vpc`).
