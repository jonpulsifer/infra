---
name: validate-build
description: >-
  Check that a change validates before you commit: Nix evaluation and host
  builds, Kubernetes renders, OpenTofu validation, TypeScript, shell, and the
  wiki. Use after editing nix/, clusters/, terraform/, apps/, packages/ or
  docs/, and before opening a PR.
metadata:
  runbook: docs/runbooks/test-a-change.md
  wiki: https://wiki.lolwtf.ca/runbooks/test-a-change/
---

# Validate a build

The procedure is `docs/runbooks/test-a-change.md`. Its table maps each kind of
change to the local command and the CI workflow that runs it. These notes cover
what an agent needs beyond it.

## Notes

- Run only the rows your change touches. `mise tasks ls` lists every task, and
  a task encodes the right binary: `tofu`, never `terraform`.
- A PR whose checks are all green can have run nothing. Each workflow starts
  only for the paths in its filter. Read which jobs ran before you call a
  change tested.
- `nix flake check` evaluates every host and builds nothing. `nix-ci.yaml`
  builds the hosts only after a merge to `main`, so build each changed host
  on its build host, as the runbook's `nix:build` row shows.
- `mise run k8s:render-apps` renders both clusters. It also runs
  `helm template` on each in-repo chart that a rendered HelmRelease names, with
  that release's values. Run it for a chart change too. It names and skips a
  chart from a `HelmRepository` or an `OCIRepository`.
- No `mise` render task runs Flux's `postBuild` substitution. The
  `kubernetes-gitops` skill names the command that does.
- `mise run docs:check` also resolves every `docs/…md` path and wiki URL named
  in a skill or an alert rule. Run it after you rename a page.
- A rerun of a TypeScript job can replay Turbo's cached output, so a green
  rerun proves nothing new.
- Report the checks that ran and the checks you skipped.
