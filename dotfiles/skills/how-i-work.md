# How I Like to Work

User preferences for AI coding agents. Per-repo `AGENTS.md` overrides anything here.

## Communication

- Concise and direct. No filler. No restating the request.
- Markdown. Prefer code over prose.
- Show file paths clearly.

## Git & PRs

- Conventional Commits.
- All commits signed (SSH).
- If asked to PR/ship changes, create a feature branch, commit signed with SSH, open a PR, and after merge clean up local and remote branches.
- After a PR is merged, switch back to `main`, pull with `--ff-only`, delete the local feature branch, and delete the remote branch if it still exists.
- **Never** commit to `main` / `master` / default branch. Always open a PR via `gh` and watch CI.

## Quality bar

- Write tests for new functionality.
- After changing Pi-managed dotfiles, run `chezmoi apply` when requested or when changes should be live immediately.
- For Pi extension/theme changes, validate with targeted `chezmoi apply --dry-run <paths>` and JSON validation for theme/settings files.
- After non-trivial edits: lint/format, then a reviewer pass.
- For infra / cloud / k8s / IAM / Terraform changes: add a security-focused pass.

## Skill chain (when in a repo with skills installed)

```
/ctx <task>          → context-builder
/plan [task]         → planner (reads context.md)
  (confirm)
edit                 → main agent
/skill:lint-format   → only what the repo configures
/review              → diff review with verdict
/skill:submit-pr     → pre-flight + open PR
```

For small / obvious changes, skip ctx/plan and go straight to edit + `/review`.

## Aesthetic preferences

- Pi UI customizations should lean hacker/host/sysadmin vibes, but avoid being too on-the-nose. Keep splash content useful and Pi-relevant, such as context, skills, and prompts.
