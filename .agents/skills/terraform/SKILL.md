---
name: terraform
description: Work with Terraform modules in this infra repo (gcp, cloudflare, vault, argo, unifi). Covers workflow, CI behaviour, and module layout.
---

## Module Layout

Each subdirectory is an independent root module with its own state:

```
gcp/organization/       # org-level IAM, folders, billing
gcp/projects/<name>/    # per-project resources
cloudflare/             # DNS, tunnels, security rules
vault/                  # auth backends, PKI, policies
argo/                   # ArgoCD application definitions
unifi/                  # VLANs, BGP, clients
```

## Standard Workflow

Applies run through **Atlantis on the PR**, not locally. Open a PR with your `.tf`
changes; Atlantis autoplans on the changed module(s). Review the plan comment, then
comment `atlantis apply` — a successful apply automerges the PR.

```bash
cd <module-dir>
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
- `gcp/organization/` manages the GCP org hierarchy — changes affect all projects.
- `cloudflare/` Tunnel modules control external ingress for folly and offsite clusters.
