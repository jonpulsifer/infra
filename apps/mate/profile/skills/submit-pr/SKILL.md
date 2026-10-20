---
name: submit-pr
description: Use when the user says "open a PR", "submit a PR", "ship it", or after implementation+review is done. Creates a feature branch when needed, commits relevant changes in sensible signed commits, runs pre-flight checks, seeds PR body from .agent/context/context.md when present, pushes branch, and opens a PR via gh against main. Never commits to main.
---

# Submit Pull Request

Open a well-formed GitHub PR for the current work.

We prefer "GitHub Flow", small feature branches off the latest remote default repository branch, usually "main". The skill may create a branch and commit pending relevant changes, but must never commit directly to `main` / `master` / the default branch.

## Pre-flight

Run in order. Stop and report if any fails.

1. **Discover base/default branch** — run `git fetch origin` and derive the base with `git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@'`; default to `main` if unavailable.
2. **Branch check / creation** — never PR from `main`/`master`/default. If currently on one, create and switch to a new descriptive branch before staging anything (for example `fix/<short-summary>` or `feat/<short-summary>`). If already on a feature branch, and it is related to the current work, stay there. Otherwise consider it dirty and 
3. **Inspect pending changes** — run `git status --short` and `git diff --stat`. If there are pending changes, identify the files relevant to the user's request. Do not stage unrelated files, generated scratch files, `.agent/`, secrets, or local-only changes unless explicitly requested.
4. **Lint pass** — run `/skill:lint-format` (or invoke its workflow inline) on the relevant changed files. Report; don't block on warnings unless the user asked for strict mode.
5. **Commit pending relevant changes** — group related files into sensible conventional commits. Stage only the files for each logical commit and use signed commits (`git commit -S -m "<type>(<scope>): <subject>"`). If changes are unrelated or ambiguous, stop and ask how to split them.
6. **Clean tree check** — `git status --porcelain` must be empty after committing relevant changes. If unrelated/untracked files remain, list them and ask whether to ignore, commit, or remove before proceeding.
7. **Review suggestion** — if `git log <base>..HEAD` shows changes that weren't reviewed (no recent `reviewer` output in chat), suggest running `/skill:reviewer` first. Wait for go-ahead.
8. **Sync with base** — `git fetch origin && git rebase origin/<base>`.

## PR Body

Prefer this source order:

1. `.agent/context/context.md` exists → derive the **Summary** from its "Request" section and **Changes** from `git log <base>..HEAD --oneline`.
2. No context file → derive **Summary** from the most recent commit subject, **Changes** from `git log`.

Template:

```markdown
## Summary
<1–2 sentence outcome>

## Changes
- <commit subject 1>
- <commit subject 2>

## Test Plan
- [ ] <how to verify>

## Context
<paths to any .agent/context/*.md that exist, for reviewer reference>
```

## Push & Open

Write the PR body to a tempfile to avoid heredoc/quoting footguns, then use `--body-file`:

```bash
git push -u origin HEAD

base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')
: "${base:=main}"

body=$(mktemp)
trap 'rm -f "$body"' EXIT
cat > "$body" <<MD
## Summary
<1–2 sentence outcome>

## Changes
- <commit subject 1>
- <commit subject 2>

## Test Plan
- [ ] <how to verify>
MD

gh pr create --base "$base" \
  --title "<conventional-type>: <subject>" \
  --body-file "$body"
```

## Conventional Commit Prefixes for the Title

`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `perf`, `build`, `ci`

## After Opening

Reply with:
- PR URL
- base branch
- whether CI has kicked off
- suggestion to run `/skill:triage-pr` if the user wants autonomous follow-through
