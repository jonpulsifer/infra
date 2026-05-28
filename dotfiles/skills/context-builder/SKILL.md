---
name: context-builder
description: Use before planning or implementing anything non-trivial in an unfamiliar codebase, when a task spans multiple files, when the user asks "how does X work", or when a downstream agent (planner, reviewer) will need source-backed context. Explores the repo, reads relevant files with line ranges, asks only consequential questions, and writes a context handoff file.
---

# Context Builder

You map a request onto a codebase and produce a high-signal handoff another agent (or your future self) can act on without re-reading everything.

## Output Location

Write to `.agent/context/context.md`. Create `.agent/context/` if missing. The `.agent/` tree is globally gitignored; this repo uses git worktrees per task so files won't clobber each other across tasks.

## Thoroughness

Infer from the task; default **medium**. Announce the level you picked at the top of `context.md`.

- **quick** — single-file change, bug with obvious locus. Targeted grep, read only the hit and its tests.
- **medium** — multi-file feature or refactor. Follow imports one hop, read entry points, callers, tests, config.
- **thorough** — architectural change, security work, cross-cutting refactor. Trace data flow, read adjacent patterns, check migrations and CI config.

## Workflow

1. **Parse the request.** Identify the concrete outcome. Note explicit files, URLs, PRs, issues.
2. **Search before reading.** `rg`, `git grep`, `find`, `ls`. Don't read whole files until search points you somewhere.
3. **Read with purpose.** Follow imports, callers, tests, fixtures, config, docs. Stop when you can explain the implementation area and validation path.
4. **Ask only when it changes the plan.** Explore first. If a safe assumption exists, state it and continue. Don't ask things the repo answers.
5. **Write the handoff.** Concise, source-backed, no hedging dumps.

## `context.md` Format

```markdown
# Context: <one-line task summary>

_Thoroughness: medium · Generated: <date>_

## Request
Restate what the user wants in 1–3 sentences.

## Relevant Files
1. `path/to/file` (lines X-Y) — why
2. `path/to/file` (lines X-Y) — why

## Key Evidence
Small, load-bearing snippets — types, signatures, configs, failing tests. Inline code blocks with paths.

## Existing Patterns
Patterns already in the codebase the next agent should follow (e.g. "errors are returned, not panicked"; "config goes through `chezmoidata.yaml`").

## Likely Implementation Area
Files/functions that will probably change, and why.

## Constraints & Risks
Real invariants: compat, security, migration, perf, conventions enforced by CI.

## Validation Path
Exact commands or checks to run. If not runnable here, name the closest proxy.

## Open Questions
Only what's still ambiguous and consequential. Empty section if nothing.
```

## Final Response

After writing, reply with:

- path to the file you wrote
- top 3 findings in one line each
- any blocking questions

Keep the chat reply short. The file is the artifact.
