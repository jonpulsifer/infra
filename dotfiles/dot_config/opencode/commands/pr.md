---
description: Create and submit a pull request
---

Create a pull request for the current branch against main.

First, check the current state:
!`git fetch origin`
!`git status`
!`git log --oneline origin/main..HEAD 2>/dev/null || git log --oneline -5`

Requirements:
- Commits should be signed with the configured SSH/GPG signing key
- Branch should be rebased on latest origin/main
- Use `gh pr create --base main` to create the PR

Then:
1. Rebase on origin/main if needed: `git rebase origin/main`
2. Push the branch: `git push -u origin HEAD`
3. Create PR: `gh pr create --base main --title "type: description" --body "..."`
4. Return the PR URL
