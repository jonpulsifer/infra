---
name: submit-pr
description: Use when the user says "open a PR", "submit a PR", "ship it", or after implementation+review is done. Runs pre-flight checks (lint, suggest review), seeds PR body from .agent/context/context.md when present, pushes branch, and opens a PR via gh against main. Never commits to main.
---

# Submit Pull Request

Open a well-formed GitHub PR for the current branch. You assume edits are committed; if not, surface what's uncommitted and stop.

## Pre-flight

Run in order. Stop and report if any fails.

1. **Branch check** — never PR from `main`/`master`/default. If on one, stop and tell the user to make a branch.
2. **Clean tree** — `git status --porcelain` must be empty. If not, list the unstaged/uncommitted files and stop.
3. **Lint pass** — run `/skill:lint-format` (or invoke its workflow inline) on changed files. Report; don't block on warnings unless the user asked for strict mode.
4. **Review suggestion** — if `git log <base>..HEAD` shows changes that weren't reviewed (no recent `reviewer` output in chat), suggest running `/skill:reviewer` first. Wait for go-ahead.
5. **Sync with base** — `git fetch origin && git rebase origin/main` (or the repo's default branch).

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
