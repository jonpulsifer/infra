---
title: Build and release
description: How first-party code builds, how its images and charts publish and deploy, how Renovate updates dependencies, and which CI checks run on a pull request.
---

First-party code lives in `apps/` (services), `packages/` (shared code and charts) and `images/` (base and tool images). GitHub Actions tests it, publishes its images and charts, and opens the pull requests (PRs) that deploy them.

## Parts

| Part | Job | Where it lives |
| --- | --- | --- |
| Bun workspace | Runs `lint`, `typecheck`, `build` and `test` in each workspace through Turborepo | `package.json`, `turbo.json` |
| Image list | Lists each Dockerfile's image under `build` or `ignore`, and under `deploy` the manifests that pin it | `.github/containers.json` |
| Image build | Builds each `build` image and pushes `ghcr.io/jonpulsifer/<image>` from `main` | `.github/workflows/containers.yml` |
| Charts | Helm charts that Flux installs | `packages/charts/` |
| Renovate | The dependency-update bot. Its `packageRules` set which updates merge unreviewed and how long each waits. | `.github/renovate.json5` |
| Runners | GitHub-hosted, and the ARC (Actions Runner Controller) pools `infra-folly` and `infra-offsite` for manual dispatches | `clusters/base/apps/arc/` |

## Continuous delivery

On a push to `main`, `containers.yml` builds each image whose watch paths changed. For an image with `deploy` targets, it cuts `cd/update-<image>-digest` from `main` and rewrites the digest in each target. It opens a PR that merges when its checks pass.

It writes no digest older than the one on `main` or in the open PR. A daily run rebuilds each image whose pin is behind `main`.

`.github/workflows/spindrift-charts.yml` publishes `packages/charts/spindrift/` and `packages/charts/spindrift-app/` to GHCR, and their OCIRepository objects pin a version tag. Flux loads the other charts in `packages/charts/` from the `infra` GitRepository with `reconcileStrategy: Revision`, so it re-renders them on each commit to `main`. Under `clusters/`, Renovate skips first-party images and charts.

## CI checks

A path that no workflow lists runs no checks, and its PR still passes. `.github/scripts/validation-impact.sh` routes paths to [OpenTofu roots](opentofu.md) and `nix flake check`.

| Workflow | Checks |
| --- | --- |
| `nix-ci.yaml` | `nix flake check` on PRs, and host and image builds on `main` |
| `typescript.yml` | The Bun workspace, when a path on its list changes |
| `kustomize.yml` | Renders each Flux Kustomization path, and templates in-repo charts with their HelmRelease values. It skips charts from a HelmRepository or OCIRepository. |
| `go.yml`, `rust.yml` | The Go and Rust modules on their lists |

## Rules

- Put each new image on the `build` or `ignore` list, or `containers.yml` fails.
- Give a deployed image `deploy` targets, or nothing deploys it.
- Keep the `CD_APP_ID` variable and `CD_APP_PRIVATE_KEY` secret set, or `GITHUB_TOKEN` opens the digest PR, which runs no checks and never merges.
- Keep the CD App's `<slug>[bot]` login in [`only-me.rego`](opentofu.md#rules), or Atlantis blocks every digest PR.
- Test each new Go module in `go.yml` or its own workflow, or no CI runs its tests. `apps/orgpolicyauditor` and `terraform/gcp/projects/lolcorp/audit-pipeline` have none.
- Bump an OCI chart's `version` and its OCIRepository `ref.tag` together, or the tests in `apps/spindrift/test/conformance/` fail.
- Make a new OCI chart public on GHCR after its first push, or its OCIRepository fails to pull.

## Related

- [How changes ship](how-changes-ship.md)
- [Test a change](../runbooks/test-a-change.md)
