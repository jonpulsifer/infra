---
description: Explore the codebase and write a context handoff for the given task
argument-hint: "<task or question>"
---
Run the `context-builder` skill for this request:

> $ARGUMENTS

Default thoroughness: **medium**. Bump to **thorough** if the request mentions security, migration, refactor, or architecture. Drop to **quick** for a single-file bug.

Explore first. Only ask me questions whose answers actually change the plan. Write the handoff to `.agent/context/<branch-slug>/context.md` and reply with the path plus your top 3 findings.
