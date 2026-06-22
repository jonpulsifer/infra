---
name: terraform
description: >-
  Work with Terraform modules in this infra repo (everything under terraform/:
  gcp, cloudflare, argo, unifi, tailscale, google-workspace, k8s).
  Covers workflow, CI behaviour, and module layout.
---

## Module Layout

All Terraform lives under `terraform/`. Each subdirectory below is an independent root module with its own state:

```
terraform/gcp/organization/       # org-level IAM, folders, billing
terraform/gcp/projects/<name>/    # per-project resources
terraform/cloudflare/             # DNS, tunnels, security rules
terraform/argo/                   # ArgoCD application definitions
terraform/unifi/                  # VLANs, BGP, clients
terraform/tailscale/              # devices, routes, ACL policy
terraform/google-workspace/       # Workspace users, groups, domains
terraform/modules/                # reusable modules consumed via relative paths
clusters/folly/bootstrap/         # Flux bootstrap for the folly cluster
clusters/offsite/bootstrap/       # Flux bootstrap for the offsite cluster
```

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
- `terraform/cloudflare/` Tunnel modules control external ingress for folly and offsite clusters.
- `terraform/modules/` are reusable (no backend); root modules reference them via relative paths (e.g. homelab-ng → `../../../modules/gce-vpc`).
