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

```bash
cd <module-dir>
terraform init
terraform plan
terraform apply
```

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
