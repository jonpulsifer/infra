---
description: Review current diff with the reviewer skill; optional flavor (security, performance, tests, dx, conventions, dependencies, correctness)
argument-hint: "[flavor | base-ref | freeform]"
---
Run the `reviewer` skill on the current changes.

**Argument parsing** (`$ARGUMENTS`):
- A known flavor (`security`, `performance`, `tests`, `dx`, `conventions`, `dependencies`, `correctness`) → pass to reviewer as the flavor.
- A git ref (e.g. `main`, `origin/main`, a SHA, or contains `/`) → review `git diff $ARGUMENTS...HEAD` with general flavor.
- `<flavor> <ref>` → both.
- Empty → staged diff if present, else unstaged diff, general flavor.
- Other freeform text → layer as extra focus on top of a general review.

Cite file and line for every finding. End with the mode-appropriate verdict.
