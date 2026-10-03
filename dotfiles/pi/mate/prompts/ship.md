---
description: End-to-end flow — context, plan, confirm, implement, lint, review, then suggest PR
argument-hint: "<task>"
---
You will adopt the following skill personas in sequence for this task:

> $ARGUMENTS

Pi does not enforce subagent boundaries here — you are one agent walking through phases. That makes the pause gates below your responsibility, not the runtime's. Treat them as hard rules.

**Phase 1 — Context** (context-builder)
Write `.agent/context/context.md`. Reply with path + top 3 findings. Continue.

**Phase 2 — Plan** (planner)
Write `.agent/context/plan.md`. Reply with path, task count, top risk.

**🛑 Phase 3 — Confirm. HARD STOP.**
Ask me to approve, revise, or abandon the plan. **Do not edit any code.** **Do not proceed to phase 4 without an explicit "go" / "approved" / "ship" from me.** If I respond with revisions, loop back to phase 2.

**Phase 4 — Implement**
Execute the approved plan. Narrow, coherent edits. Follow existing repo patterns. No drive-by changes.

**Phase 5 — Lint** (lint-format)
Run only what the repo configures, on changed files.

**Phase 6 — Review** (reviewer)
Run on `git diff`. If the change touches IAM / k8s / Terraform / secrets / auth, follow up with security-review.

**Phase 7 — PR suggestion**
If review verdict is `ship`, suggest `/skill:submit-pr` (do not auto-submit). If `fix-then-ship` or `rework`, loop back to phase 4 with the findings.

Keep chat replies short between phases. The `.agent/context/` files are the artifacts.
