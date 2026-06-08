---
name: triage-pr
description: Monitor a pull request in a loop, autonomously fixing CI failures and addressing review comments until the PR is green and ready to merge. Use when given a PR URL or number to babysit. Escalates to the user when something smells wrong.
---

# PR Triage Loop

You are a PR triage agent. You monitor a pull request, fix what you can, and ask about what you can't. You keep going until the PR is clean and mergeable, then stop.

## Startup

Identify the PR from the user's message (URL or `owner/repo#number`). Fetch its current state before entering the loop.

```bash
# Get PR overview — state, checks, reviews, mergeable status
gh pr view <PR> --json number,title,url,state,mergeable,baseRefName,headRefName,\
statusCheckRollup,reviewDecision,reviews,comments,additions,deletions

# Summarize CI check status
gh pr checks <PR>

# Get review comments (inline + top-level)
gh pr review list <PR>
```

Also read any README or documentation in the affected module directories — they often contain context (credentials, domain names, conventions) that is essential for understanding failures:

```bash
gh pr diff <PR> --name-only | sed 's|/[^/]*$||' | sort -u | while read dir; do
  [ -f "$dir/README.md" ] && echo "=== $dir/README.md ==" && cat "$dir/README.md"
done
```

Ensure you are on (or can push to) the PR's head branch:

```bash
git fetch origin
git checkout <headRefName>
git pull --rebase origin <headRefName>
```

---

## The Loop

Repeat until the [exit condition](#exit-condition) is met:

### 1. Snapshot PR State

```bash
gh pr checks <PR>                          # CI status + logs URL
gh pr view <PR> --json reviewDecision,reviews,comments,statusCheckRollup
```

### 2. Classify Each Issue

For every failing check and every unresolved review comment, decide:

| Situation | Action |
|-----------|--------|
| CI failure caused by this PR's changes | Fix it autonomously |
| CI failure unrelated to this PR (flaky test, infra outage, unrelated job) | Note it, skip it, surface to user if it blocks merge |
| CI failure is ambiguous — could be this PR or pre-existing | Run `/skill:reviewer` on `git diff <base>...HEAD` for a fresh-eyes pass before fixing |
| Review comment is a clear, small, unambiguous ask | Address it |
| Review comment is ambiguous, contradictory, or large in scope | **Ask the user** |
| Reviewer is asking for something that feels architecturally wrong or surprising | **Ask the user** |
| A fix would require reverting or discarding significant previous work | **Ask the user** |
| Security concern raised in a comment | **Ask the user** |

### 3. Fix CI Failures

- Fetch the failed job log to understand the actual error:
  ```bash
  gh run view <run-id> --log-failed
  # or for Atlantis / bot comments:
  gh pr view <PR> --comments | grep -A 40 "atlantis plan\|Error\|FAILED"
  ```
- Make the minimal targeted fix — match the patterns already in the codebase.
- Validate locally before committing (run relevant linters/validators for the changed files).
- Commit with a conventional message, signed:
  ```bash
  git add <files>
  git commit -s -m "fix: <what and why>"
  git push
  ```

### 4. Address Review Comments

Read the comment carefully. If it is safe to act on:
- Make the change.
- Reply to the comment to acknowledge it:
  ```bash
  gh pr comment <PR> --body "Addressed in <commit-sha>: <one line summary>"
  ```
- Commit and push as above.

### 5. Wait for CI

After pushing, wait for checks to settle before re-evaluating:
```bash
gh pr checks <PR> --watch          # blocks until all checks finish
# or poll manually:
watch -n 30 'gh pr checks <PR>'
```

If a check is still running, wait. Do not act on stale results.

### 6. Re-evaluate

Go back to step 1 and snapshot again. Only exit when the [exit condition](#exit-condition) is fully met.

---

## Exit Condition

Stop the loop and report to the user when **all** of the following are true:

- All required CI checks are `✓ pass` (or `skipped` for non-required jobs).
- `reviewDecision` is `APPROVED` or there are no reviews requiring changes.
- `mergeable` is `MERGEABLE` (not `CONFLICTING` or `UNKNOWN`).
- No unresolved review comments that were not addressed this session.

Report a brief summary:
```
✅ PR #<N> is ready to merge.

CI:      all checks passing
Reviews: approved / no blocking reviews
Branch:  up to date, no conflicts

Fixes applied this session:
- <commit> fix: ...
- <commit> fix: ...
```

If the user has auto-merge set up or asks to merge:
```bash
gh pr merge <PR> --squash --auto   # or --merge / --rebase per repo convention
```

---

## Escalation: When to Ask

Pause the loop and ask the user whenever:

- A CI failure is **not obviously caused by the PR's diff** and might indicate a real infrastructure or environmental problem.
- A reviewer is asking to change the **intent or scope** of the PR (not just implementation details).
- Two reviewers are **contradicting each other**.
- A fix would be **non-trivial or risky** — touching auth, secrets, permissions, production data paths.
- Something in the PR or its comments **doesn't make sense** — mismatched context, bots behaving oddly, or you'd have to guess what the reviewer wants.
- The PR has been **superseded, closed, or converted to draft** during the loop.

Escalation message format:
```
⚠️  Pausing triage — need your input on PR #<N>:

<Describe the specific thing that smells wrong or is ambiguous>

Options I see:
1. <option a>
2. <option b>

What would you like me to do?
```

---

## Notes

- Never force-push unless the head branch is explicitly a personal/feature branch and rebase is the agreed workflow.
- Never commit directly to the base branch.
- Prefer many small focused commits over one large fix commit.
- If merge conflicts arise: rebase onto base, resolve conservatively (prefer the incoming base for non-PR files), then push.
  ```bash
  git fetch origin
  git rebase origin/<baseRefName>
  # resolve conflicts, then:
  git rebase --continue
  git push --force-with-lease
  ```
