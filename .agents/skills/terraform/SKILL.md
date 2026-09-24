---
name: terraform
description: >-
  Change, validate or plan the OpenTofu root modules under terraform/ and
  clusters/<site>/bootstrap/. Use when editing .tf files, reading a plan, or
  when a change needs an Atlantis apply.
metadata:
  runbook: docs/runbooks/apply-an-opentofu-change.md
  wiki: https://wiki.lolwtf.ca/runbooks/apply-an-opentofu-change/
---

# OpenTofu

The procedure is `docs/runbooks/apply-an-opentofu-change.md`. The platform
page is `docs/platform/opentofu.md`. These notes cover what an agent needs
beyond them.

## Notes

- Run `tofu`. `terraform` is installed, but Atlantis and CI use OpenTofu.
- Use the tasks:
  - `mise run tf:validate` initializes and validates every root.
  - `mise run tf:fmt` formats.
  - `mise run tf:docs` regenerates the terraform-docs READMEs.
  - `TF_DIR=<root> mise run tf:plan` plans one root.
  - To validate one root:
    `tofu -chdir=<root> init -backend=false && tofu -chdir=<root> validate`.
- A root is a directory whose `.tf` files declare a `backend` block
  (`.github/scripts/validation-impact.sh terraform-roots` lists them). Anything
  else is a module.
- Atlantis autoplans a root when a `*.tf*` file in it or in a module it uses
  changes. A `.conf` or `.hujson` change under `terraform/` also triggers it
  (`ATLANTIS_AUTOPLAN_FILE_LIST` in
  `clusters/offsite/apps/atlantis/helm-release.yaml`).
- A PR that changes only a file a root reads with `file()`, such as a topology
  JSON file, `clients.yaml` or `flux-values.yaml`, gets no plan. Comment
  `atlantis plan -d <root>` on the PR.
- `plan-hook.sh` lets only the identities in `atlantis_users` in
  `only-me.rego` plan. A comment of `atlantis apply` applies the plans and
  merges the PR. Comment `atlantis apply` only when the owner asks.
- Network facts come from the topology files through
  `terraform/modules/cluster-topology`, which a root instantiates in its
  `topology.tf`.
- `terraform/pki` uses the `opentofu/tls` provider for `max_path_length`, and
  the `terraform` binary cannot install that provider.
- CI runs `tofu test` in each directory with a changed `.tf` or `.tftest.hcl`
  file. The `.tftest.hcl` files are in `clusters/<site>/bootstrap/`.
- For a change to Kubernetes or Argo CD authentication, also use the
  `kubernetes-gitops` skill.
