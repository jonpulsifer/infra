---
name: validate-build
description: >-
  Verify this repo builds and validates cleanly before commit: Kustomize
  overlays. Use after editing clusters/
metadata:
  runbook: docs/pages/Runbooks___Validate Infra Changes.md
  wiki: https://wiki.lolwtf.ca/runbooks/validate-infra-changes/
---

# Validate Build

Canonical human runbook: `docs/pages/Runbooks___Validate Infra Changes.md`.
Reference bridge: `references/runbook.md`.

## Agent Notes

- Prefer `mise` for portable validation tooling; use Nix for NixOS-specific builds and formatters.
- For Kubernetes changes, build the kustomization root that includes the changed file.
- For shared `clusters/base/` changes, validate every consuming cluster.
- For Terraform changes, validate from the changed root with `terraform init -backend=false && terraform validate`.
- For docs changes, build the wiki with `bun run --cwd apps/wiki build`.
- Do not recommend unrelated follow-up skills at the end of validation output; report what ran and what remains.
