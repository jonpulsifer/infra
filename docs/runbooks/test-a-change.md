---
title: Test a change
description: Run the local check for each kind of change before you open a pull request, with the CI workflow that runs the same check.
---

Use this runbook before you open a pull request. It gives the local command for each kind of change and the CI workflow that runs the same check.

> [!NOTE]
> Each CI workflow starts only for the paths in its filter. A path that no filter lists runs no check, and the pull request still shows green.

## Before you start

- Run `mise install` and `bun install` from the repository root.
- For a Nix change, run `mise run devshell`.
- `mise tasks ls` lists every task. If a task exists for a check, use the task.

## Test the change

| You changed | Command | CI workflow |
| --- | --- | --- |
| `docs/`, a `.md` file, or `.agents/` | `mise run docs:check` | `wiki.yml` |
| `apps/wiki/` | `bun run --cwd apps/wiki test`, then `mise run docs:build` | `wiki.yml` |
| `nix/`, `flake.nix`, `flake.lock`, `dotfiles/`, or a topology JSON file | `mise run nix:check` | `nix-ci.yaml` |
| One NixOS host | `NIX_REMOTE=ssh-ng://<build-host> HOST=<host> mise run nix:build` | None before the merge |
| `clusters/` or `packages/charts/` | `mise run k8s:render-apps`, then `mise run k8s:check-rules` | `kustomize.yml` |
| One directory under `clusters/<site>/` with a `kustomization.yaml` | `kubectl kustomize clusters/<site>/<dir>` | None |
| `clusters/<site>/config/cluster-topology.json` | `conftest verify -p .github/policy`, then the `conftest test` command in `topology-contract.yml` | `topology-contract.yml` |
| A `.tf` or `.terraform.lock.hcl` file | The local checks in [Apply an OpenTofu change](apply-an-opentofu-change.md) | `terraform.yml` |
| A `.tftest.hcl` file | `mise run tf:init`, then `tofu -chdir=<root> test` | `terraform.yml` |
| TypeScript in `apps/` or `packages/` | `mise run ts:check`, then `bun run test` | `typescript.yml`, if its `changed-files` list names the path |
| A Go module in `apps/` | `go -C apps/<app> vet ./...`, then `go -C apps/<app> test ./...` | `go.yml`, `rackstat.yml` or `view-counter.yml`, if one of them lists the module |
| `apps/fml-pki/` or `terraform/pki/certs/` | `mise run pki:verify` | `go.yml` |
| `apps/fml-derive-rs/` or `apps/fml-ceremony/` | `mise run rust:test`, then `mise run pki:crosscheck` | `rust.yml` |
| A shell script in `scripts/`, `.github/scripts/` or `dotfiles/` | `mise run check` | `shell.yml` |
| `dotfiles/` | `mise -C dotfiles run dotfiles:check` | `dotfiles.yml` |
| `.github/scripts/validation-impact.sh` | `mise run validation-impact:test` | `terraform.yml` |
| `.github/scripts/cd-*.sh` or `.github/workflows/containers.yml` | `mise run cd-digest:test` | `containers.yml` |

`<build-host>` is the machine that builds the host, from the table in [Deploy a NixOS host](deploy-a-nixos-host.md#before-you-start).

1. List the files that the branch changes.

   ```bash
   git diff --name-only main...HEAD
   ```

   Result: One changed file on each line.

2. Find the Nix check and the OpenTofu directories that CI checks for these files.

   ```bash
   git diff --name-only main...HEAD | .github/scripts/validation-impact.sh targets
   ```

   Result: `nix:flake-check`, one `terraform:<dir>` line for each root or module that the change affects, or no output.

3. For each row of the table that matches a changed file, run its command from the repository root.

   Result: Each command completes without an error. `docs:check` prints `ok` after each check.

4. If you changed `docs/`, search the pages for secret values.

   ```bash
   grep -rn -i -E -e 'BEGIN [A-Z ]*PRIVATE KEY' -e '(password|secret|token) *[:=] *[^ <$]' docs
   ```

   Result: Each line that can hold a secret.

5. Make sure that no line from step 4 holds a secret value.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| `docs:check` prints `MISSING` and a path. | A page names a repository path that does not exist. | Correct the path in the page. |
| `docs:check` prints `BROKEN`, a file and a wiki reference. | The file points at a page path that the wiki does not serve. The wiki has no redirects. | Point the reference at the current path of the page. |
| `docs:check` prints `past tense in docs`. | A page describes history. | Describe the current state. |
| `bun run test` cannot connect to Postgres. | The [kthx](../apps/kthx.md) tests in `apps/spindrift/` need a database. | Set `DATABASE_URL`, as `apps/spindrift/README.md` describes. |
| `mise tasks ls` exits with an error. | mise does not trust the configuration of the checkout. | Run `mise trust`. |

## Related

- [Apply an OpenTofu change](apply-an-opentofu-change.md): the OpenTofu checks and the Atlantis apply.
- [Apply a Kubernetes change](apply-a-kubernetes-change.md): the Flux path.
- [Deploy a NixOS host](deploy-a-nixos-host.md): deploy a host after the build.
- [Build and release](../platform/build-and-release.md): CI routing and the workflows.
