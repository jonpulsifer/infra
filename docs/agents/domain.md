# Domain docs

This page tells agent skills, such as `domain-modeling` and `diagnosing-bugs`,
where the repo's domain documentation is and how to read it.

## Read order

1. `AGENTS.md` at the repo root. `CLAUDE.md` is a symlink to it.
2. The wiki pages in `docs/`. Start at `docs/platform/index.md`, then read the
   page for the area you will change.

This repo has no `CONTEXT.md` and no ADRs. A decision is a present-tense
statement on the page for the thing it decides.

## Vocabulary

Use the term the repo uses in issue titles, proposals, hypotheses and test
names. `docs/reference/glossary.md` defines the lab's terms. If a term is
missing, the glossary has a gap or the repo does not use the concept.

## Contradictions

If your output contradicts a wiki page, say so and name the page:

> _Contradicts `docs/platform/kubernetes.md` on how the root sync is owned,
> because…_

If the page is stale, fix it in the same change.

## Writing

Edits to `docs/` follow "Writing rule for these docs" in `AGENTS.md` and
`docs/reference/style-guide.md`. `docs/` is public, so it never holds a
decrypted secret or a credential.
