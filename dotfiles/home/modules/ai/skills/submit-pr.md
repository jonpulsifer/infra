---
name: submit-pr
description: Create and submit a GitHub pull request. Use when the user wants to submit, create, or open a PR/pull request for their changes.
---

# Submit Pull Request

Create a well-structured GitHub pull request for the current changes.

## Prerequisites

- Commits must be signed (GPG/SSH) and signed-off (DCO)
- Use `git commit -s` to add DCO sign-off
- Branch should be based on latest main

## Workflow

1. **Sync with main**: Ensure branch is up to date
2. **Check status**: Run `git status` and `git diff` to understand changes
3. **Ensure committed**: All changes committed with sign-off (`-s`)
4. **Push branch**: Push to remote with `git push -u origin HEAD`
5. **Create PR**: Use `gh pr create` against main

## Commands

```bash
# Ensure you're up to date with main
git fetch origin
git rebase origin/main

# Check current state
git status
git log --oneline origin/main..HEAD

# If you need to amend with sign-off
git commit --amend -s --no-edit

# Push and create PR
git push -u origin HEAD
gh pr create --base main --title "feat: description" --body "..."
```

## PR Format

Use this structure for the PR body with `gh pr create`:

```bash
gh pr create --base main --title "type: description" --body "$(cat <<'EOF'
## Summary
Brief description of what this PR does (1-2 sentences)

## Changes
- Bullet points of specific changes made

## Test Plan
- [ ] How to verify this works

Signed-off-by: Name <email>
EOF
)"
```

## Conventional Commits

Use these prefixes for PR titles:
- `feat:` new feature
- `fix:` bug fix
- `docs:` documentation
- `refactor:` code restructuring
- `chore:` maintenance tasks
