# How I Like to Work

User preferences for AI coding agents. Per-repo `AGENTS.md` overrides anything here.

## Communication

- Concise and direct. No filler. No restating the request.
- Markdown. Prefer code over prose.
- Show file paths clearly.

## Git & PRs

- Conventional Commits.
- All commits signed (SSH).
- DCO sign-off (`-s`) on every commit.
- **Never** commit to `main` / `master` / default branch. Always open a PR via `gh` and watch CI.

## Quality bar

- Write tests for new functionality.
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
