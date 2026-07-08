---
name: terraform
description: >-
  Work with Terraform modules in this infra repo. All root modules live under
  terraform/: cloud/identity (gcp, argo, google-workspace, vault) and network
  fabric under terraform/network/ (unifi/folly, unifi/offsite, cloudflare, tailscale).
  Covers workflow, CI behaviour, and module layout.
metadata:
  runbook: docs/pages/Runbooks___Terraform Change.md
  wiki: https://wiki.lolwtf.ca/runbooks/terraform-change/
---

# Terraform

Canonical human runbook: `docs/pages/Runbooks___Terraform Change.md`.
Reference bridge: `references/runbook.md`.

## Agent Notes

- Applies run through Atlantis on the PR, never local `terraform apply` against remote state.
- Root modules are standalone under `terraform/` plus `clusters/<site>/bootstrap/`.
- For local validation, run from the changed root:
  ```bash
  terraform init -backend=false
  terraform validate
  ```
- Formatting: `terraform fmt -recursive`.
- Local `terraform plan` is inspection only.
- If a change touches Kubernetes/Argo auth behavior, also use the `kubernetes-gitops` skill.
