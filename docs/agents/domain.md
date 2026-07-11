# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root (single-context repo).
- **ADRs** live in the Logseq graph under `docs/pages/ADR___NNNN <title>.md` (e.g. `docs/pages/ADR___0001 GitOps apply model.md`), with `docs/pages/ADR___Template.md` as the copy template. Read ADRs that touch the area you're about to work in. ADR status/date live as Logseq `key:: value` page properties.

If `CONTEXT.md` doesn't exist yet, **proceed silently**. Don't flag its absence; don't suggest creating it up front. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates it lazily when terms or decisions actually get resolved.

## File structure

Single-context repo:

```
/
├── CONTEXT.md
└── docs/
    └── pages/
        ├── ADR___Template.md
        ├── ADR___0001 GitOps apply model.md
        └── ADR___NNNN <title>.md
```

Note: this repo publishes `docs/` as a public Logseq wiki at wiki.lolwtf.ca — never put decrypted SOPS content or credentials in `docs/` (or in `CONTEXT.md`).

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_

When you create a new ADR, copy `docs/pages/ADR___Template.md`, name it `ADR___NNNN <title>.md` with the next free number, and fill in `status::`/`date::` page properties.