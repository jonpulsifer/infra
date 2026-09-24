# Issue tracker: local Markdown (private)

Specs and tickets are Markdown files under `.agent/plans/`. The
repo is public and the planning files are private. Only the owner's global
git ignore file excludes `.agent/`. Before you commit, make sure `git status`
shows nothing under `.agent/`.

## Layout

- One directory for each feature: `.agent/plans/<feature-slug>/`.
- The spec is `.agent/plans/<feature-slug>/spec.md`.
- Each ticket is one file, `.agent/plans/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from `01`.
- A `**Status:** <value>` line near the top of a ticket holds its triage
  label. `triage-labels.md` lists the labels.
- Comments go at the end of the file under a `## Comments` heading.

## Publish a ticket

When a skill says "publish to the issue tracker", create the file under
`.agent/plans/<feature-slug>/`. Never run `gh issue create`, because the
repo's issues are public.

## Fetch a ticket

Read the file at the path or ticket number the owner gives.

## Pull requests and commits

A PR body or commit message stands on its own. State the defect, the mechanism
and the evidence in the text. Leave out ticket numbers, spec names,
`.agent/` paths and links to issues in other projects. A `file:line` reference
to source code is fine.

## Wayfinding operations

`/wayfinder` is a personal skill. It maps an effort too large for one session
as a map file and child tickets under `.agent/wayfinder/<effort>/`.

- Map: `map.md`, with the sections Destination, Notes, Decisions so far, Not yet
  specified and Out of scope.
- Child ticket: `issues/<NN>-<slug>.md`, numbered from `01`, with the question
  in the body. A `Type:` line holds `research`, `prototype`, `grilling` or
  `task`. A `Status:` line holds `open`, `claimed`, `resolved` or `closed`
  (out of scope).
- Blocking: a `Blocked by: NN, NN` line near the top. A ticket is unblocked
  when every ticket it lists is `resolved`.
- Frontier: the open, unblocked and unclaimed tickets. The lowest number goes
  first.
- Claim: set `Status: claimed` and save the file before any work.
- Resolve: append the answer under `## Answer`, set `Status: resolved`, and add
  a gist and a link to Decisions so far in `map.md`.
