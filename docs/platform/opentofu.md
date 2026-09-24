---
title: OpenTofu and Atlantis
description: The OpenTofu roots that declare the network, cloud accounts, identity and cluster bootstrap, and the Atlantis server that plans and applies them from pull requests.
---

OpenTofu is the open-source fork of Terraform. The lab uses it to declare the network, the [cloud accounts](cloud.md), the [PKI](pki.md) and the bootstrap of each cluster. Atlantis, a server on the offsite cluster, plans each changed root, a directory with its own state, on a pull request (PR). It applies the root on a comment. The binary is `tofu`.

## Parts

| Part | Job | Where it lives |
| --- | --- | --- |
| Root | Has a `backend "gcs"` block | Under `terraform/`, and `clusters/<site>/bootstrap/` |
| Module | Shared code that roots call | `terraform/modules/`, and a `modules/` directory in some roots |
| State | One object for each root in the `homelab-ng` bucket | The `prefix` in the root's `backend` block, which often differs from the root's path |
| Atlantis | Plans, applies and merges PRs | `clusters/offsite/apps/atlantis/` |
| CI | Runs `tofu validate` and `tofu test` in each directory with a changed `.tf` or `.tftest.hcl` file, and `tofu fmt -check` | `.github/workflows/terraform.yml` |

## Atlantis

Atlantis plans each root with a changed file that matches `ATLANTIS_AUTOPLAN_FILE_LIST`, and each root that calls a changed module. Before a plan, the hook `plan-hook.sh` checks the GitHub identity that opened the PR or asked for the plan. `only-me.rego`, a Rego policy, lists the GitHub identities that pass.

A comment of `atlantis apply` applies the plans, and Atlantis then merges the PR. Before an apply or an `atlantis import`, the hook `apply-hook.sh` checks the commenter against `appliers.rego`, which admits only the owner. Both hooks run conftest from the policy mount, so a `conftest.toml` in a PR cannot change the result. Atlantis ignores the `atlantis.yaml` files in `clusters/<site>/bootstrap/`.

`only-me.rego` also lists `clanky-bot[bot]`, the GitHub App of [Rowbutt](../apps/mate.md), so Rowbutt can plan its own PRs. A plan runs the PR's code with Atlantis's credentials, so every identity in `only-me.rego` is trusted. The Atlantis ServiceAccount is `cluster-admin` on both clusters.

## Rules

- Apply before you merge. A merge without an apply changes nothing, and the next plan shows the change as pending.
- If a PR changes only a file that a root reads with `file()`, such as `clients.yaml`, a topology file or `flux-values.yaml`, comment `atlantis plan -d <root>`, then `atlantis apply`, before you merge. Autoplan sees only files that match `ATLANTIS_AUTOPLAN_FILE_LIST`, so the change is otherwise never applied.
- Add every GitHub identity that opens PRs to `atlantis_users` in `only-me.rego`. `atlantis/plan` is a required check on every PR, so a PR from an unlisted GitHub identity is blocked.
- Read network facts through `terraform/modules/cluster-topology`, which reads the [topology files](../reference/topology.md).
- Keep `terraform/pki` on OpenTofu. Its `opentofu/tls` provider is only on the OpenTofu registry.

## Where it lives

- `clusters/offsite/apps/atlantis/helm-release.yaml`: the autoplan list and repo config
- `clusters/offsite/apps/atlantis/policies/only-me.rego`: `atlantis_users`, who can plan
- `clusters/offsite/apps/atlantis/policies/appliers.rego`: `atlantis_appliers`, who can apply and import
- `clusters/base/atlantis-bootstrap-rbac.yaml`: the `cluster-admin` binding
- `mise.toml`: the `tf:*` tasks. No CI job checks the README tables that `tf:docs` writes.

## Related

- [Apply an OpenTofu change](../runbooks/apply-an-opentofu-change.md)
- [How changes ship](how-changes-ship.md)
- [Cloud accounts](cloud.md)
