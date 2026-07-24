---
name: onboard-repo
description: >-
  Vendor an external jonpulsifer GitHub repo into this monorepo preserving git
  history, then rewire its in-repo consumers. Use when asked to "onboard",
  "merge in", "vendor", or "absorb" a standalone repo into apps/, packages/, or
  images/.
---

# Onboard Repo

Vendoring a standalone repo into this monorepo with its history intact. This is
a development procedure, not an outage runbook — the whole thing lives here.

Rewiring the consumers is usually more work than moving the code. Budget for it.

## 1. Pick the destination

- `apps/<name>/` — deployable first-party service
- `packages/<name>/` — reusable library or Helm chart
- `images/<name>/` — base or tool OCI image

## 2. Find existing consumers first

```bash
rg -n "<name>|github:jonpulsifer/<name>|jonpulsifer/<name>"
```

## 3. Merge with history

Work on a branch, never `main`.

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

**Merge the PR as a merge commit, not a squash**, or the preserved subtree
history is flattened away and the whole exercise is wasted.

## 4. Remove dead vendored config

Workflows and Renovate config inside the vendored directory are inert here.

```bash
git rm -r apps/<name>/.github
git rm apps/<name>/renovate.json
```

For Go apps now built by the monorepo flake, remove the nested `flake.nix` and
`flake.lock` once their behaviour is replaced at the root.

## 5. Rewire consumers

- **Container images**: add the image name to `.github/containers.json`'s
  `build` list (or `ignore` if it has a Dockerfile that should not publish). An
  unclassified Dockerfile fails CI. Add a `build.json` beside the Dockerfile for
  a custom image name, context, build-args, or watch paths.
- **Deploy workflows**: recreate them as root workflows under
  `.github/workflows/<name>.yml` with paths and working directories pointed at
  the vendored location.
- **Nix-consumed Go programs**: drop the old flake input, add
  `apps/<name>/package.nix`, add an overlay under `nix/overlays/`, update the
  host modules to import the vendored module or package, and build once to get
  the correct `vendorHash`.

## 6. Validate

```bash
nix flake check
CGO_ENABLED=0 go -C apps/<name> build ./...
rg -n "inputs\.<name>|github:jonpulsifer/<name>"   # should return nothing
```

## 7. After merge

- Offer to archive the now-vendored source repo.
- Call out any deploy-time behaviour changes in the PR, especially URL or
  runtime generation changes.
- Update the vendored README: badges and clone URLs pointing at the old
  standalone repo are now dead links.
