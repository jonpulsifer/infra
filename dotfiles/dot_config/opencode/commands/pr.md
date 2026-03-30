---
description: Create and submit a pull request
---

Create a pull request for the current branch against main.

First, check the current state:
!`git fetch origin`
!`git status`
!`git log --oneline origin/main..HEAD 2>/dev/null || git log --oneline -5`

Requirements:
- All commits must be signed-off (DCO) with `git commit -s`
- Branch should be rebased on latest origin/main
- Use `gh pr create --base main` to create the PR

Then:
1. Check if commits have sign-off (look for "Signed-off-by:" in `git log`)
2. If missing sign-off, amend with `git commit --amend -s --no-edit`
3. Rebase on origin/main if needed: `git rebase origin/main`
4. Push the branch: `git push -u origin HEAD`
5. Create PR: `gh pr create --base main --title "type: description" --body "..."`
6. Return the PR URL
