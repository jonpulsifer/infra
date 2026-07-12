---
description: Produce an ordered implementation plan; reads existing context.md if present
argument-hint: "[task or refinement]"
---
Run the `planner` skill.

Task: $ARGUMENTS

If `.agent/context/<branch-slug>/context.md` exists, read it first. If it doesn't and the task is non-trivial, do a quick context pass inline before planning — don't plan blind.

Write the plan to `.agent/context/<branch-slug>/plan.md`. Reply with the path, task count, and top risk. Do not start implementing.
