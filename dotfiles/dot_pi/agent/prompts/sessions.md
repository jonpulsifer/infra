---
description: List existing Pi sessions with one-line summaries
argument-hint: "[all|project] [limit]"
---
List existing Pi sessions with one-line summaries.

Argument parsing (`$ARGUMENTS`):
- Empty or `project` → list sessions for the current working directory only.
- `all` → list sessions across every directory under `~/.pi/agent/sessions`.
- Optional numeric argument → max rows to show; default to 20.

Implementation notes:
- Inspect `~/.pi/agent/sessions/**/*.jsonl`; when not using `all`, filter to sessions whose `session.cwd` equals the current working directory.
- Parse JSONL; use the `session` record for `id`, `timestamp`, and `cwd`.
- Summarize each session from the first meaningful user message. Ignore generated context blocks, tool results, and slash-command wrapper boilerplate when possible.
- Sort newest first.

Output only a compact markdown table:

| started | id | project | what |
|---------|----|---------|------|

Keep `what` to one line. End with: `Resume: pi --session <id>` and mention `pi --resume` for interactive selection.
