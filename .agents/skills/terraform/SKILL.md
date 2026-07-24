---
name: terraform
description: >-
  Work with the OpenTofu root modules in this infra repo. All roots live under
  terraform/ (network fabric under terraform/network/, cloud and identity
  alongside it) plus clusters/<site>/bootstrap/. Use when changing, validating,
  or planning infrastructure code, or when a change needs an Atlantis apply.
metadata:
  runbook: docs/pages/Runbooks___Terraform Change.md
  wiki: https://wiki.lolwtf.ca/runbooks/terraform-change/
---

# Terraform

Canonical human runbook: `docs/pages/Runbooks___Terraform Change.md`. Layer
background: `docs/pages/Architecture___Terraform.md`. This file holds only the
agent-specific guidance.

## Agent notes

- **The binary is `tofu` (OpenTofu), not `terraform`.** Both are installed; the
  apply path is OpenTofu. The directory is still named `terraform/` — correct,
  not a bug.
- **Never apply locally against remote state.** Applies run through Atlantis on
  the PR: autoplan on changed roots, comment `atlantis apply`, successful apply
  automerges. A local apply races Atlantis for the state lock.
- Prefer the mise tasks — they encode the right binary and flags:
  ```bash
  mise run tf:validate   # init -backend=false + validate, routed to changed roots
  mise run tf:fmt        # tofu fmt -recursive
  mise run tf:docs       # regenerate terraform-docs READMEs
  TF_DIR=terraform/network/cloudflare mise run tf:plan
  ```
- Scoped fallback when you need one root only:
  ```bash
  tofu -chdir=<root> init -backend=false && tofu -chdir=<root> validate
  ```
- A root is any directory whose `.tf` has a `backend "` block. That is how CI
  tells a root from a reusable module — `.github/scripts/validation-impact.sh`
  greps for it.
- `tofu test` runs in CI. `clusters/<site>/bootstrap/` carry `.tftest.hcl`
  files; most roots have none, where the command is a no-op.
- Network facts come from the topology SSOT via the
  `terraform/modules/cluster-topology` module, instantiated in a root's
  `topology.tf`. Never hardcode a CIDR, ASN, or API-server address.
- `terraform/pki` requires OpenTofu specifically — it uses the `opentofu/tls`
  provider fork for `max_path_length`, which is not published for Terraform.
- If a change touches Kubernetes or ArgoCD auth behaviour, also use the
  `kubernetes-gitops` skill.
