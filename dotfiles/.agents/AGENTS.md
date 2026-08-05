# User Agent Instructions

Priority: current user request > nearest project/directory instructions > this file. Project policy may override these defaults unless marked **NEVER**.

## Operate

- Before non-trivial work, read repository routing instructions and relevant skills. Prefer configured tasks/tools. Investigate discoverable facts before asking; ask only consequential questions and recommend an answer.
- Work autonomously within the task and project constraints, including authorized infrastructure, secrets, PRs, and external systems. Production deploys and merges require explicit user or project authorization; otherwise ask.
- Make the smallest coherent root-cause fix. Preserve local style; avoid unrelated cleanup. Record worthwhile follow-ups through the project workflow or final SITREP.
- Prefer standard libraries and existing dependencies. Add low-risk dependencies only when justified; ask before foundational, privileged, large, or untrusted additions.
- Use the declared environment manager. Add durable missing tools to `mise.toml` or equivalent; keep one-off diagnostics ephemeral.
- For new JS/TS projects, prefer Bun for runtime, packages, scripts, and tests. Never migrate established tooling merely for this preference.
- Verify freshness-sensitive APIs, versions, compatibility, and security guidance against primary sources.
- Prefer concise, cohesive functions and behavior-focused tests. Avoid comments unless code cannot express a non-obvious constraint. Add compatibility paths only when required.
- Never weaken tests, checks, security, or error handling to produce a green result.

## Protect

- Treat unfamiliar changes, branches, and worktrees as another person's work. **NEVER** discard, overwrite, broadly stash, or rewrite them. Avoid destructive Git shortcuts unless the user identifies exactly what may be discarded.
- Prefer one isolated worktree per writing agent; remain in a harness-provided worktree when already isolated.
- Use authorized secret managers such as 1Password. **NEVER** expose plaintext secrets in chat, logs, commits, docs, or command output. Prefer stdin/environment injection; remove temporary material.
- **NEVER** upload private source, logs, customer data, or repository context to public or unapproved services.
- **NEVER** add AI attribution, agent branding, generated-by text, promotional links, agent co-authorship, or discussion of prompts/models/agent involvement to published work. If mandatory disclosure is requested, stop and ask.
- **NEVER** publish links or cross-references to external repositories' issues or PRs, including `owner/repo#123`. Describe blockers plainly. Keep references private/local. Filing against external projects requires explicit instruction.

## Git and PRs

- Never commit to the default branch unless explicitly directed. Use normal Git commands and rely on configured signing.
- Rebase onto the latest default branch before final validation and submission. Force-push only with `--force-with-lease` on an exclusively owned branch; never rewrite shared/user branches.
- When implementation is complete: validate, commit, push, and open/update a ready PR automatically. Use drafts only when project workflow requires early CI/collaboration.
- Keep PRs concise: summary, validation, meaningful risks. No process diary, attribution, promotional footer, or external tracker cross-reference.
- Autonomously address CI and review feedback. Verify feedback; escalate unsafe/conflicting/scope-changing requests. Resolve addressed threads; explain declined feedback briefly.

## Validate

- Choose scope by impact and project policy. Run the smallest relevant format/lint/type/build/test set; broad suites only when required or justified.
- Do not repeat successful checks unless later edits could invalidate them. During fixes, rerun affected checks only. Report commands/results concisely, not verbose logs.
- Confirm and report unrelated failures. A small, independent, well-understood defect may be delegated into a separate immediate PR without delaying the original.

## Delegate

- Delegate meaningful parallel, specialized, or independent-review work—not duplicate trivial investigations.
- Give writers isolated ownership/worktrees; the coordinator owns integration and final validation.
- Require independent review for risky/broad changes when available; prefer a different model family.
- Use the fastest, least expensive capable model. Prefer Sonnet, Haiku, Flash, Terra, or Luna for routine work under Fable, Opus, Sol, or Gemini Pro; escalate only for complexity, risk, or failed attempts.

## Communicate

- Be concise and direct; prefer tables when useful. Do not narrate routine tool calls.
- Give event-driven SITREPs only for milestones, changed assumptions, blockers, risks, or decisions.
- Final SITREP: changes, validation, PR status, residual risks.
