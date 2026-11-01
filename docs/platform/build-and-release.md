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
| Build entry | An image's watch paths, context, aliases and build options, and the turbo `workspace` of an image built from `turbo prune` | `<dir>/build.json` |
| Image build | Builds each `build` image and pushes `ghcr.io/jonpulsifer/<image>` from `main` | `.github/workflows/containers.yml` |
| Talos images | Builds folly's signed Talos installer, ISO, iPXE and HookOS. See [Kubernetes](kubernetes.md#signed-talos-images). | `.github/workflows/talos-images.yml` |
| Charts | Helm charts that Flux installs | `packages/charts/` |
| Renovate | The dependency-update bot. Its `packageRules` set which updates merge unreviewed and how long each waits. | `.github/renovate.json5` |
| Runners | GitHub-hosted, and the ARC (Actions Runner Controller) pools `infra-folly` and `infra-offsite` for manual dispatches | `clusters/base/apps/arc/` |

## Continuous delivery

### Image selection

On a push to `main`, `containers.yml` builds images whose watch paths change.

For a workspace image, a change only to `package.json`, `bun.lock` or `turbo.json` needs an additional check. `.github/scripts/image-affected.sh` asks `turbo ls --affected` whether that workspace changes. If Turbo cannot answer, the image builds.

### Delivery pull request

1. Each build records its image digest.
2. The `deliver` job creates `cd/update-digests` from `main`.
3. It updates the built images in their declared `deploy` targets.
4. It preserves the digests waiting in the open delivery PR, then force-pushes the branch.
5. The PR merges when its checks pass.

One run opens or updates one PR. Its merge commit includes `[skip ci]`, so no workflow runs for that commit on `main`.

The PR checks are the gate. The TypeScript workflow skips its test job when only image digests change in declared delivery targets.

### Digest ordering and retries

The delivery job does not write a digest older than one on `main` or in the open delivery PR.

A per-image `cd/update-<image>-digest` PR stays open until it merges or a newer delivery closes it.

> [!CAUTION]
> A workflow rerun uses the workflow from that run. A run that lacks the delivery job can open a per-image PR with an older digest.

Use `workflow_dispatch` with `images` to republish named images.

The daily run rebuilds images whose pins are behind `main`. For workspace images, `image-affected.sh` compares the pinned commit with the newest commit touching the watch paths. A lockfile change that the push skips therefore does not trigger a daily rebuild.

A build adds nothing to the PR if its filesystem and configuration match every pin on `main` and the delivery branch. The daily run treats it as current.

### Build triggers

| Change or request | Result |
| --- | --- |
| PR changes `containers.yml`, `detect-containers.sh`, `image-affected.sh` or `.github/containers.json` | Build every image without publishing. |
| `main` changes how the build job builds images | Rebuild every image. |
| `main` changes `.github/containers.json` | Build images whose `build` entries or `deploy` targets change. |
| `main` changes only `detect-containers.sh` or `image-affected.sh` | Build nothing. |
| `workflow_dispatch` with `images` | Republish the named images. |
| Change only under `clusters/` | Do not run `containers.yml`. |

### Helm charts

`.github/workflows/spindrift-charts.yml` publishes `packages/charts/kthx-engine/` and `packages/charts/kthx-app/` to GHCR, and their OCIRepository objects pin a version tag. Flux loads the other charts in `packages/charts/` from the `infra` GitRepository with `reconcileStrategy: Revision`, so it re-renders them on each commit to `main`. Under `clusters/`, Renovate skips first-party images and charts.

## Renovate

Renovate merges stable npm minor and patch updates as one weekly PR, so the Bun images rebuild once a week for them. Majors and 0.x updates arrive as their own PRs.

Chainguard node base digests (`:latest` and `:latest-dev`) move together in one PR each Monday and Thursday, so a base-image fix reaches the images within about four days. The kthx CLI pin in `images/mate-sandbox/Dockerfile` and the verifier pin in `apps/kthx-engine/Dockerfile` move weekly, and the owner reviews each.

Renovate rebases a PR only when it conflicts with `main`. Terraform and Talos PRs rebase whenever they fall behind, because Atlantis applies the PR's own plan.

## CI checks

A path that no workflow lists runs no checks, and its PR still passes. `.github/scripts/validation-impact.sh` routes paths to [OpenTofu roots](opentofu.md) and `nix flake check`.

| Workflow | Checks |
| --- | --- |
| `nix-ci.yaml` | `nix flake check` on PRs, and host and image builds on `main` |
| `typescript.yml` | The Bun workspace, when a path on its list changes. A change that only moves a first-party image digest in a `deploy` target of `.github/containers.json` skips it. |
| `kustomize.yml` | Renders each Flux Kustomization path, and templates in-repo charts with their HelmRelease values. It skips charts from a HelmRepository or OCIRepository. |
| `go.yml`, `rust.yml` | The Go and Rust modules on their lists |

## Rules

- Put each new image on the `build` or `ignore` list, or `containers.yml` fails.
- Give a deployed image `deploy` targets, or nothing deploys it.
- Keep the `CD_APP_ID` variable and `CD_APP_PRIVATE_KEY` secret set, or `GITHUB_TOKEN` opens the digest PR, which runs no checks and never merges.
- Keep the CD App's `<slug>[bot]` login in [`only-me.rego`](opentofu.md#rules), or Atlantis blocks every digest PR.
- Test each new Go module in `go.yml` or its own workflow, or no CI runs its tests. `apps/orgpolicyauditor` has none.
- Bump an OCI chart's `version` and its OCIRepository `ref.tag` together, or the tests in `apps/kthx-engine/test/conformance/` fail.
- Make a new OCI chart public on GHCR after its first push, or its OCIRepository fails to pull.

## Related

- [How changes ship](how-changes-ship.md)
- [Test a change](../runbooks/test-a-change.md)
