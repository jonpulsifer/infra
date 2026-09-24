---
title: Apply an OpenTofu change
description: Change an OpenTofu root, check it on your machine, and apply it through Atlantis on the pull request.
---

Use this runbook to change the OpenTofu code in `terraform/` or `clusters/<site>/bootstrap/`. OpenTofu (`tofu`) is the open-source fork of Terraform. A root is a directory whose `.tf` files declare a `backend` block, and each root has its own state. A module is a directory of `.tf` files that roots call, such as a directory in `terraform/modules/`. Atlantis is the server that plans and applies roots from pull request comments. A successful apply merges the pull request.

> [!CAUTION]
> Do not run `tofu apply` on your machine. A local apply competes with Atlantis for the state lock, and the live resources then differ from the state.

## Before you start

- Run `mise install`. Run every command with `tofu`, the OpenTofu binary that Atlantis and CI use.
- To plan, your GitHub account must be in `atlantis_users` in `clusters/offsite/apps/atlantis/policies/only-me.rego`. To apply, it must be in `atlantis_appliers` in `appliers.rego` in the same directory.
- A local plan takes the state lock, so it needs write access to objects in the `homelab-ng` state bucket. It also needs the provider credentials of the root, such as `OP_SERVICE_ACCOUNT_TOKEN`.
- The backends of `terraform/gcp/projects/trusted-builds` and `terraform/gcp/projects/bluenose` impersonate `terraform@homelab-ng.iam.gserviceaccount.com`. A local plan of those roots needs the right to impersonate it.

## Check the change on your machine

1. List the OpenTofu directories that the branch changes.

   ```bash
   git diff --name-only main...HEAD | .github/scripts/validation-impact.sh targets
   ```

   Result: One `terraform:<dir>` line for each root or module that the change affects. A change to only a `.tftest.hcl` file prints no line.

2. If a directory is a module, find the roots that call it.

   ```bash
   grep -rl --include='*.tf' 'modules/<module>"' terraform clusters
   ```

   Result: The `.tf` files that call the module.

3. Format the `.tf` files.

   ```bash
   mise run tf:fmt
   ```

   Result: The name of each file that `tofu fmt` changed, or no output.

4. Validate the roots.

   ```bash
   mise run tf:validate
   ```

   Result: `Success! The configuration is valid` after each `==> tofu validate <root>` line.

5. If the root has a `.tftest.hcl` file, run its tests.

   ```bash
   tofu -chdir=<root> test
   ```

   Result: `Success!`, then the counts of passed and failed tests.

6. Regenerate the README tables of the roots and modules.

   ```bash
   mise run tf:docs
   ```

   Result: One `==> <dir>` line for each directory whose README has `BEGIN_TF_DOCS` markers.

> [!CAUTION]
> `tf:plan` initializes the real backend and locks the state of the root. Do not run it while Atlantis plans or applies the same root.

7. If you need a plan before the pull request, run a local plan.

   ```bash
   TF_DIR=<root> mise run tf:plan
   ```

   Result: `No changes.`, or `Plan:` and the counts to add, change and destroy.

## Apply the change with Atlantis

1. Push the branch.
2. Open a pull request.
3. Wait for the Atlantis comments.

   Result: A `Ran Plan for` comment, then a `Ran Policy Check for` comment. Each names the roots that Atlantis planned.

> [!CAUTION]
> Atlantis plans a root only when a changed file in the root, or in a module that it calls, matches `ATLANTIS_AUTOPLAN_FILE_LIST` in `clusters/offsite/apps/atlantis/helm-release.yaml`. Other files that a root reads with `file()` get no plan, such as `flux-values.yaml` in a bootstrap root, `clients.yaml` and the topology JSON files. A pull request without a plan merges, and its change is not applied.

4. If Atlantis did not plan a root that the change affects, comment the plan command for that root.

   ```text
   atlantis plan -d <root>
   ```

5. Read each plan. If a plan replaces or deletes a resource that you did not change, do not apply it.

> [!CAUTION]
> If you plan with `-target`, the apply still merges the pull request. The resources outside the target stay unapplied.

6. Apply the plans.

   ```text
   atlantis apply
   ```

   Result: A `Ran Apply for` comment, then `Automatically merging because all plans have been successfully applied.`

7. Make sure that the pull request merged.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The plan fails with `is not in the allowed users list`. | The GitHub account that ran the command is not in `atlantis_users`. | Run the command from an account in the list. |
| Atlantis prints `Automerging failed` and `Required status check "<check>" is in progress` or `is failing`. | A required check did not pass before the apply completed. | When the checks pass, merge the pull request. |
| Atlantis prints `Automerging failed` and `405 Pull Request has merge conflicts`. | The branch conflicts with `main`. | Rebase the branch on `main`. Push the branch. Comment `atlantis plan -d <root>`. Comment `atlantis apply`. |
| The pull request merged, but the change is not live. | Atlantis did not plan the root. | Open a new pull request. Comment `atlantis plan -d <root>`. Comment `atlantis apply`. |
| `init` cannot install an `opentofu/*` provider, such as the `opentofu/tls` provider of `terraform/pki`. | You ran `terraform`. | Run `tofu`. |
| The state of a root is not at the path of the root in the bucket. | The `prefix` in the `backend` block of the root differs from its path. | Use the `prefix` from the `backend` block. |

## Related

- [Test a change](test-a-change.md): the checks for other kinds of change.
- [OpenTofu and Atlantis](../platform/opentofu.md): the roots, the state and the Atlantis server.
- [How changes ship](../platform/how-changes-ship.md): the GitOps rule.
