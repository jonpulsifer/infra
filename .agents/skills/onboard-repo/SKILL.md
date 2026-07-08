---
name: onboard-repo
description: >-
  Vendor an external jonpulsifer GitHub repo into this monorepo, preserving git
  history, then rewire its in-repo consumers. Use when asked to "onboard",
  "merge in", "vendor", or "absorb" a standalone repo into apps/, packages/, or
  images/.
metadata:
  guide: docs/pages/Contributing___Onboard Repo.md
  wiki: https://wiki.lolwtf.ca/contributing/onboard-repo/
---

# Onboard Repo

Canonical contributor guide: `docs/pages/Contributing___Onboard Repo.md`.
Reference bridge: `references/runbook.md`.

## Agent Notes

- Work on a branch, never `main`.
- Pick the destination first: `apps/`, `packages/`, or `images/`.
- Grep for existing consumers before merging history.
- Preserve history with `git filter-repo --to-subdirectory-filter <dest>` and merge with `--allow-unrelated-histories`.
- Remove dead vendored `.github/` and Renovate config unless content needs to be ported to root-level config.
- Rewire CI, deploy workflows, Nix flake inputs, overlays, and host modules as needed.
- The PR should merge as a merge commit, not squash, so preserved subtree history remains useful.
