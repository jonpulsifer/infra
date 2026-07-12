# Skills

Source-of-truth Agent Skills for this dotfiles repo. Each skill lives in `skills/<name>/SKILL.md`; `mise.toml` deploys the whole `skills/` directory directly (no per-skill wrapper files) to:

- `~/.agents/skills/` — read by pi
- `~/.claude/skills/`
- `~/.gemini/config/skills/`

Global "how I work" preferences live in `skills/how-i-work.md` and are deployed to `~/.pi/agent/AGENTS.md` and `~/.claude/CLAUDE.md` — always in context, not loaded on demand.

## Catalog

| Skill | Purpose | Writes | Trigger |
|-------|---------|--------|---------|
| `context-builder` | Explore codebase, produce source-backed handoff | `.agent/context/context.md` | "how does X work", before planning, unfamiliar repo |
| `planner` | Ordered implementation plan from context | `.agent/context/plan.md` | Multi-file change, "plan this out" |
| `reviewer` | Diff/plan/proposal review with verdict; takes optional flavor | — | Before PR, "review this" |
| `security-review` | Deep cloud/infra/k8s/IAM security audit | — | IaC, secrets, networking, auth changes |
| `lint-format` | Detects + runs the repo's configured tooling | — | Before commit / PR |
| `submit-pr` | Pre-flight checks + open PR with seeded body | — | "open a PR", "ship it" |
| `triage-pr` | Autonomous PR babysitting loop (pi-only) | — | "watch this PR" |

## The Chain

```
/ctx <task>          → context-builder writes context.md
/plan [task]         → planner reads context.md, writes plan.md
  (user confirms)
edit code            → main agent implements
/skill:lint-format   → runs configured tooling on changed files
/review              → reviewer on git diff; verdict ship / fix-then-ship / rework
/skill:submit-pr     → pre-flight + open PR (seeds body from context.md)
/skill:triage-pr     → optional: babysit the PR until merge-ready
```

Or just `/ship <task>` for the whole orchestrated flow with confirm points.

## When to Invoke What

- **Single-line bug fix you fully understand** → just edit, then `/review`.
- **Multi-file change** → `/ctx` → `/plan` → confirm → edit → `/skill:lint-format` → `/review`.
- **Big architectural / security change** → `/ship` with extra `/skill:security-review` after `/review`.
- **Open a PR for finished work** → `/skill:submit-pr`.
- **PR is open and needs babysitting** → `/skill:triage-pr <pr-url>`.

## Small Tasks Escape Hatch

The full chain is overkill for small changes. Use your judgment:

| Change size | Recommended flow |
|-------------|------------------|
| Typo / one-line / obvious bug | edit → commit |
| Single-file feature you understand | edit → `/review` → commit |
| Multi-file change | `/ctx` → `/plan` → edit → `/skill:lint-format` → `/review` |
| Cross-cutting / risky | `/ship` (full orchestrated chain with confirm gate) |

The ceremony is there when you need it; skip it when you don't.

## Storage Convention

Skills write artifacts to `.agent/context/` in the working repo. This dir is globally gitignored via `.config/git/ignore`. We use git worktrees per task, so two parallel tasks never share an `.agent/` directory and don't clobber each other.

## Adding a Skill

1. Create `skills/<name>/SKILL.md` with `name:` and `description:` frontmatter. Description should start with "Use when…" and name concrete triggers (under 1024 chars).
2. No wrapper files needed — `mise.toml` deploys the whole `skills/` directory to all three locations, so the new file is picked up automatically.
3. If pi-specific, put it in `.pi/agent/skills/<name>/SKILL.md` instead (not shared with claude/gemini).
4. `mise dotfiles apply --dry-run` to validate, then `mise dotfiles apply`.

## Prompt Templates (pi)

Lightweight aliases over skills, in `.pi/agent/prompts/`:

- `/ctx <task>` — context-builder with thoroughness hint
- `/plan [task]` — planner, auto-reads context.md
- `/review [flavor|base-ref]` — reviewer on diff; accepts a flavor (security, performance, tests, dx, conventions, dependencies, correctness)
- `/ship <task>` — full orchestrated chain with confirm gate
- `/skills` — list available skills with one-line whens
