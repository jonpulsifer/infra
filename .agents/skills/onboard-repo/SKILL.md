---
name: onboard-repo
description: >-
  Vendor an external jonpulsifer GitHub repo into this monorepo with its git
  history, then rewire what consumes it. Use when asked to onboard, merge in,
  vendor or absorb a standalone repo into apps/, packages/ or images/.
---

# Onboard a repo

This skill moves a standalone repo into the monorepo with its history, then
rewires its consumers. No runbook covers it, so the procedure is here. The
rewiring usually takes longer than the move.

## 1. Pick the destination

- `apps/<name>/`: a deployable service or tool.
- `packages/<name>/`: a shared library or Helm chart.
- `images/<name>/`: a base or tool OCI image.

## 2. Find the consumers

```bash
rg -n "<name>|github:jonpulsifer/<name>|jonpulsifer/<name>"
```

## 3. Merge with history

Work on a branch.

```bash
repo=<name>
dest=apps/$repo
rm -rf "/tmp/$repo"
gh repo clone "jonpulsifer/$repo" "/tmp/$repo" -- -q
branch="$(git -C /tmp/$repo branch --show-current)"
( cd "/tmp/$repo" && nix run nixpkgs#git-filter-repo -- --to-subdirectory-filter "$dest" )
git remote add "temp-$repo" "/tmp/$repo"
git fetch -q "temp-$repo"
git merge "temp-$repo/$branch" --allow-unrelated-histories -m "Merge $repo into $dest"
git remote remove "temp-$repo"
rm -rf "/tmp/$repo"
```

Merge the PR with a merge commit. A squash merge discards the vendored
history.

## 4. Remove vendored config that does nothing here

The vendored repo's workflows and Renovate config do not run in the monorepo.

```bash
git rm -r apps/<name>/.github
git rm apps/<name>/renovate.json
```

## 5. Rewire the consumers

- Container image: add the image to the `build` or `ignore` list in
  `.github/containers.json`. CI fails on a Dockerfile in neither list. Add it
  to `deploy` too if a manifest pins its digest. A `build.json` beside the
  Dockerfile sets a custom image name, context, build arguments or watch paths.
- Workflows: write each one as `.github/workflows/<name>.yml` at the root,
  with paths and working directories under the new location.
- Go program that Nix consumes: remove the old flake input, add
  `apps/<name>/package.nix` and an overlay under `nix/overlays/`, and point the
  host modules at them. `apps/ddnsd/` is an example. Build once to get the
  `vendorHash`. Then remove the app's nested `flake.nix` and `flake.lock`.

## 6. Validate

```bash
mise run nix:check
CGO_ENABLED=0 go -C apps/<name> build ./...
rg -n "inputs\.<name>|github:jonpulsifer/<name>"
```

Result: the last command prints nothing.

## 7. Before the PR merges

- List any change in deploy behaviour in the PR, such as a new URL or a
  different build.
- Update the vendored README. Its badges and clone URLs point at the old repo.

## 8. After the PR merges

Offer to archive the source repo.
