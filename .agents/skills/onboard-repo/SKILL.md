---
name: onboard-repo
description: >-
  Vendor an external jonpulsifer GitHub repo into this monorepo, preserving git
  history, then rewire its in-repo consumers. Use when asked to "onboard",
  "merge in", "vendor", or "absorb" a standalone repo into apps/, packages/, or
  images/.
---

## Overview

Onboarding = (1) merge the external repo's source into the monorepo with full
history, then (2) rewire whatever the monorepo already used from the external
repo so it points at the vendored copy. Most repos worth onboarding are *already
consumed* (a flake input, an ArgoCD/Flux ref, a terraform-managed SA). Grep
first — the rewiring is usually the bigger half of the job.

```bash
grep -rln "<repo-name>" . | grep -v '\.git/'
```

## 1. Pick the destination

| Kind | Goes in | Examples |
|------|---------|----------|
| Deployable first-party service (has a Dockerfile / deploys somewhere) | `apps/<name>/` | hermes, minecraft, ddnsd, view-counter, tidbyt |
| Reusable lib / chart consumed by other code | `packages/<name>/` | agent-web-ui, charts |
| Base or tool OCI image | `images/<name>/` | base, kubectl, atlantis, cloudlab-linux |

## 2. Merge with history

There's a zsh helper, `monorepo-merge` (in `dotfiles/dot_config/zsh/dot_zshrc.tmpl`),
that clones the repo, runs `git filter-repo --to-subdirectory-filter`, and merges
with `--allow-unrelated-histories`. It defaults to a **top-level** `<repo>/` dir.

To land directly under `apps/` (etc.), run the same mechanism retargeted. Work on
a branch, never `main`:

```bash
git checkout -b onboard/<name>
repo=<name>; dest=apps/$repo      # or packages/$repo, images/$repo
rm -rf "/tmp/$repo"
gh repo clone "jonpulsifer/$repo" "/tmp/$repo" -- -q
branch="$(git -C /tmp/$repo branch --show-current)"
# git-filter-repo isn't on PATH here; run it via nix
( cd "/tmp/$repo" && nix run nixpkgs#git-filter-repo -- --to-subdirectory-filter "$dest" )
git remote add "temp-$repo" "/tmp/$repo"
git fetch -q "temp-$repo"
git merge "temp-$repo/$branch" --allow-unrelated-histories -m "Merge $repo into $dest"
git remote remove "temp-$repo"; rm -rf "/tmp/$repo"
```

**Merge the PR as a merge commit, not squash** — squashing flattens the
preserved subtree history, defeating the point.

## 3. Strip dead vendored config

GitHub only runs workflows in the repo-root `.github/workflows`, and Renovate
only reads the root config. So inside the vendored dir these are dead and should
be removed (port anything still needed to the root — see step 4):

```bash
git rm -rq apps/<name>/.github
git rm -q  apps/<name>/renovate.json        # if present
```

For a Go app whose Nix build moves into the monorepo flake, also drop its nested
flake: `git rm apps/<name>/flake.nix apps/<name>/flake.lock`.

## 4. Rewire consumers

- **CI / container image**: add the app to the matrix in
  `.github/workflows/containers.yml` (`image`, `context`, `watch`) if it ships a
  container.
- **Deploy workflow** (e.g. a GCP Cloud Function): recreate it as a root
  workflow `.github/workflows/<name>.yml`, path-filtered to `apps/<name>/**`,
  with `source_dir`/`working-directory` pointing at the vendored path. Pin
  actions to SHAs (`gh api repos/<owner>/<repo>/git/refs/tags/<tag>`); bump any
  node16-era actions so they actually run.
- **Nix-consumed Go program** (the ddnsd pattern): the repo shipped a flake the
  monorepo imported as an input. Replace it:
  1. Remove the `inputs.<name>` block from the root `flake.nix`; `nix flake lock`.
  2. Add `apps/<name>/package.nix` (a `callPackage`-style `buildGoModule`) and an
     overlay `nix/overlays/<name>.nix` →
     `final: prev: { <name> = final.callPackage ../../apps/<name>/package.nix {}; }`.
  3. In the host module that used the input (e.g. `nix/system/<name>.nix`):
     `imports = [ ../../apps/<name>/module.nix ];`
     `nixpkgs.overlays = [ (import ../overlays/<name>.nix) ];`
  4. **vendorHash gotcha**: the upstream flake's `vendorHash` is often stale
     (go.sum drifted via renovate). Build it, let Nix print the real hash, paste
     it in.

## 5. Validate

```bash
# Nix package builds + correct vendorHash (use the flake's nixpkgs):
nix build --impure --no-link --expr \
  'let p = (builtins.getFlake (toString ./.)).inputs.nixpkgs.legacyPackages.x86_64-linux; in p.callPackage ./apps/<name>/package.nix { }'
# A host that imports the module still evaluates:
nix eval --raw .#nixosConfigurations.<host>.config.system.build.toplevel.drvPath
grep -rn "inputs.<name>\|github:jonpulsifer/<name>" --include='*.nix' .   # expect none
# Go apps compile (pure shell has no cgo compiler):
nix shell nixpkgs#go -c bash -c 'CGO_ENABLED=0 go -C apps/<name> build ./...'
```

See `validate-build` for the broader pre-commit checks.

## 6. After merge

Offer to archive the now-vendored source repos
(`gh repo archive jonpulsifer/<name>`). Call out any deploy-time behavior change
(e.g. a Cloud Function gen1→gen2 migration changes the URL) so nothing surprises
on the first merge to `main`.
