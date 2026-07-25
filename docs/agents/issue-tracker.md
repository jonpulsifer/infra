# Issue tracker: Local Markdown (private)

Issues and specs (you may know a spec as a PRD) for this repo live as markdown
files under **`.agent/plans/`**. This directory is gitignored (via the global
`~/.config/git/ignore` `.agent/` rule), so PRDs, tickets, triage state, and
iteration **never reach the public `jonpulsifer/infra` repo**. Keeping the
planning surface private is the whole point — code and PRs stay public with full
CI; the messy decision-making does not.

## Conventions

- One feature per directory: `.agent/plans/<feature-slug>/`
- The spec is `.agent/plans/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at
  `.agent/plans/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01` —
  never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file
  (see `triage-labels.md` for the role strings — for a local tracker they are
  `Status:` values, not GitHub labels)
- Comments and conversation history append to the bottom of the file under a
  `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.agent/plans/<feature-slug>/` (creating the directory
if needed). Do **not** `gh issue create` — that would leak it to the public repo.

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or
the ticket number directly.

## Shipping to the public repo

When work is ready, the PR goes to the public `jonpulsifer/infra` as normal
(`gh pr create`, Atlantis/Flux/Nix CI). Reference the private spec in the PR body
by its role or a one-line summary, not by pasting the raw iteration — the private
files stay private. A public PR linking to a local `.agent/plans/` path is fine;
the path simply isn't resolvable by outsiders, which is intended.

## Wayfinding operations

Used by `/wayfinder`. Efforts keep their established home under
`.agent/wayfinder/<effort>/` (also gitignored). The **map** is a file with one
**child** file per ticket.

- **Map**: `.agent/wayfinder/<effort>/map.md` — the Notes / Decisions-so-far /
  Fog body.
- **Child ticket**: `.agent/wayfinder/<effort>/issues/NN-<slug>.md`, numbered
  from `01`, with the question in the body. A `Type:` line records the ticket
  type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records
  `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked
  when every file it lists is `resolved`.
- **Frontier**: scan `.agent/wayfinder/<effort>/issues/` for files that are open,
  unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set
  `Status: resolved`, then append a context pointer to the map's
  Decisions-so-far in `map.md`.
