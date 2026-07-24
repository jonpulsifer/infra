---
name: validate-build
description: >-
  Verify this repo validates cleanly before committing — Nix flake check, host
  builds, kustomize renders, OpenTofu validate, and the wiki build. Use after
  editing nix/, clusters/, terraform/, or docs/, and before opening a PR.
metadata:
  runbook: docs/pages/Runbooks___Validate Infra Changes.md
  wiki: https://wiki.lolwtf.ca/runbooks/validate-infra-changes/
---

# Validate Build

Canonical human runbook: `docs/pages/Runbooks___Validate Infra Changes.md`.
This file holds only the agent-specific guidance.

## Agent notes

Validate by change area — running everything is slow and usually unnecessary.

| Changed | Run |
| --- | --- |
| `terraform/**`, `clusters/*/bootstrap/**` | `mise run tf:validate`, `mise run tf:fmt` |
| `clusters/**` | `mise run k8s:render-apps` (what CI runs), or `kubectl kustomize clusters/<site>/<category>` |
| `nix/**`, `flake.nix` | `mise run nix:check`; `HOST=<host> mise run nix:build` for one closure |
| `docs/**`, `apps/wiki/**` | `mise run docs:build`, then `mise run docs:check` |
| TypeScript under `apps/`, `packages/` | `mise run ts:check` |
| `dotfiles/` shell scripts | `mise run check` (scoped to `dotfiles/`, not repo-wide) |

- **`mise` is the command source of truth** — `mise tasks ls` lists everything.
  Prefer a task over a raw invocation; the task encodes the right binary. In
  particular the OpenTofu binary is `tofu`, never `terraform`.
- For `clusters/base/` changes, render **both** clusters — they are not
  symmetric and a base change can render on folly and fail on offsite.
- `nix flake check` evaluates every host and is slow. When iterating on one
  host, build just that closure.
- `mise run docs:check` enforces the docs contract: every wikilink resolves,
  every referenced repo path exists, no past-tense archaeology. It runs in CI,
  so run it locally before pushing docs.
- Report what actually ran and what remains unverified. Do not claim a
  validation passed if you skipped it, and do not pad the output with unrelated
  follow-up suggestions.
