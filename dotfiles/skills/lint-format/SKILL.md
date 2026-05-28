---
name: lint-format
description: Use before committing, before opening a PR, or when the user says "lint" or "format". Inspects the repo's actual tooling manifests (mise.toml, package.json scripts, pyproject.toml, etc.) and runs only what the repo configures. Reports auto-fixes applied and findings that still need manual work. Does not invent tooling.
---

# Lint & Format

You run the linters and formatters this repo *actually configures*. You don't invent tools. You don't lecture about tools that aren't installed.

## Discovery (in priority order)

Inspect, in order, and prefer whatever's listed:

1. **`mise.toml` / `.tool-versions`** — pinned tool versions in this repo. Anything here is fair game.
2. **`package.json` scripts** — if `scripts.lint`, `scripts.format`, `scripts.check`, `scripts.typecheck` exist, prefer `npm run <script>` (or `pnpm`/`yarn`/`bun` based on the lockfile) over invoking the tool directly.
3. **`pyproject.toml`** — read `[tool.*]` sections (`ruff`, `black`, `mypy`, `isort`). Run only what's configured.
4. **Tool-specific config files** — `.golangci.yml`, `biome.json`, `.eslintrc*`, `.prettierrc*`, `.tflint.hcl`, `.markdownlint*`, `.yamllint*`, `.shellcheckrc`, `.editorconfig`, etc. Presence implies use.
5. **Language manifests** — `go.mod` → `gofmt`/`go vet`; `Cargo.toml` → `cargo fmt`/`cargo clippy`; `*.tf` → `terraform fmt`; `*.sh` → `shellcheck` if available.
6. **Repo-specific scripts** — a `Makefile`, `justfile`, or `Taskfile.yml` target named `lint`/`fmt`/`check`/`ci` is often the right entry point. Prefer it.

If you find tooling config that isn't in the lists above, run it anyway — the config's existence is the signal. Report what you ran.

## Scope

Default: **changed files only**.

```bash
git diff --name-only
git diff --cached --name-only
git ls-files --others --exclude-standard
```

Full-repo run only when:
- the user asks ("lint everything"),
- a config or lockfile change might affect the whole repo, or
- the tool doesn't support targeting individual files.

## Workflow

1. List what you detected and what you'll run, up front.
2. Formatters first (auto-fix allowed).
3. Linters second.
4. Capture exit code and resulting diff for each step.
5. Report.

## Output

```markdown
## Detected
- mise.toml: <tools>
- package.json scripts: lint, format
- Other: shellcheck (3 changed shell scripts)

## Ran
- `npm run format` — ok
- `npm run lint` — ok
- `shellcheck dot_local/bin/executable_agent-skills` — 0 findings

## Auto-fixed
- `path/to/file` — formatter applied

## Manual fixes needed
- `path/to/file:42` — <linter>: <message>

## Skipped
- ruff: no `[tool.ruff]` in pyproject.toml
- golangci-lint: no Go files changed
```

If everything passes with nothing to fix: one line — "lint/format clean, N tools ran."

## Leaf skill

This is a leaf in the chain. Do **not** recommend running other skills (reviewer, submit-pr, etc.) at the end of your output. Just report what you ran and what's left.
