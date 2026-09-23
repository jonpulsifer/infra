# Domain Docs

How the engineering skills should consume this repo's documentation when
exploring the codebase.

## Before exploring, read these

- **`AGENTS.md`** at the repo root. It is a router, not a manual: hard rules,
  how changes ship, the repo map, and the single sources of truth.
- **The wiki** in `docs/`, which is where depth lives. Start from
  `docs/platform/index.md` and read the layer page for the area you are about to
  touch. `docs/apps/` covers the first-party apps, `docs/hosts/` the hosts, and
  `docs/runbooks/` the procedures.

There is no `CONTEXT.md` and no ADR namespace in this repo. Decisions are
recorded as present-tense architecture, not as a decision log — the rationale
for a choice lives on the page describing the thing itself.

## File structure

```
/
├── AGENTS.md              # router (CLAUDE.md is a symlink to it)
└── docs/                  # Markdown pages, published at wiki.lolwtf.ca
    ├── agents/            # this directory — agent-facing, not rendered
    ├── nav.yaml           # sidebar order
    ├── index.md           # → /
    ├── apps/<app>.md      # → /apps/<app>/
    ├── platform/<layer>.md
    ├── hosts/<host>.md
    ├── runbooks/<procedure>.md
    └── assets/            # diagrams
```

The folder tree is the URL: `docs/<section>/<page>.md` is `/<section>/<page>/`,
and `index.md` is its folder's URL.

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
`docs/platform/` are the vocabulary. Don't drift to synonyms.

If a concept you need has no page, that is a signal: either you're inventing
language the project doesn't use (reconsider), or there's a real documentation
gap worth filling.

## Flag contradictions

If your output contradicts what an architecture page states, surface it
explicitly rather than silently overriding:

> _Contradicts `docs/platform/kubernetes.md` on how the root sync is owned — but
> worth reopening because…_

If the page is simply stale, fix the page in the same change. Documentation
drift is a bug, and the fix belongs with the work that found it.
