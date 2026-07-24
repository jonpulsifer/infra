# Domain Docs

How the engineering skills should consume this repo's documentation when
exploring the codebase.

## Before exploring, read these

- **`AGENTS.md`** at the repo root. It is a router, not a manual: hard rules,
  how changes ship, the repo map, and the single sources of truth.
- **The wiki** in `docs/pages/`, which is where depth lives. Start from
  `Architecture.md` and read the layer page for the area you are about to touch.
  `Fleet.md` covers the hosts; `Runbooks.md` covers procedures.

There is no `CONTEXT.md` and no ADR namespace in this repo. Decisions are
recorded as present-tense architecture, not as a decision log — the rationale
for a choice lives on the page describing the thing itself.

## File structure

```
/
├── AGENTS.md              # router (CLAUDE.md is a symlink to it)
└── docs/
    ├── agents/            # this directory — agent-facing repo config
    └── pages/             # the Logseq graph, published at wiki.lolwtf.ca
        ├── Architecture.md
        ├── Architecture___<Layer>.md
        ├── Fleet.md
        ├── Fleet___<host>.md
        └── Runbooks___<procedure>.md
```

A `/` in a Logseq page name is `___` in the filename.

Note: `docs/` is published publicly at wiki.lolwtf.ca. Never put decrypted SOPS
content or credentials in it.

## Writing rule

When your output edits documentation, follow the rules in `AGENTS.md`:

1. **Present tense, today only.** No "formerly", "used to", "previously",
   "migrated from". Git history is the archaeology record.
2. **Point, don't restate.** Never enumerate what the tree enumerates.
3. **Git is the truth; drift is a bug.** Where reality diverges, say so in
   present tense with the blocker.
4. **Verify before you write.** Every path must exist; every command must match
   what the repo runs.

## Use the repo's vocabulary

When your output names a concept — in an issue title, a refactor proposal, a
hypothesis, a test name — use the term the repo uses. The layer pages under
`docs/pages/Architecture*` are the vocabulary. Don't drift to synonyms.

If a concept you need has no page, that is a signal: either you're inventing
language the project doesn't use (reconsider), or there's a real documentation
gap worth filling.

## Flag contradictions

If your output contradicts what an architecture page states, surface it
explicitly rather than silently overriding:

> _Contradicts [[Architecture/Kubernetes]] on how the root sync is owned — but
> worth reopening because…_

If the page is simply stale, fix the page in the same change. Documentation
drift is a bug, and the fix belongs with the work that found it.
