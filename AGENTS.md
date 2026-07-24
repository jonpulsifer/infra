# AGENTS.md

Multi-layer homelab managed as code: NixOS bare metal, two Kubernetes clusters,
Terraform-managed cloud and network fabric, first-party apps and images.

This file is a **router**, not a manual. It holds the rules you must know before
you touch anything, and pointers to where the depth lives. Depth lives in
`docs/pages/` (published at [wiki.lolwtf.ca](https://wiki.lolwtf.ca)) and in
`.agents/skills/`.

## Hard rules

Read these before your first edit. They are prohibitions — routing you to them
after the fact is too late.

- **Never mutate live infrastructure.** Author desired state in git and let the
  operators apply it. This repo is GitOps-first.
- **Never `kubectl apply`** to author state. `kubectl`, `flux get`, and
  `flux reconcile` are for inspection or forcing a sync — nothing else.
- **Never run `tofu apply` against remote state.** Applies go through Atlantis
  on the PR. Local apply races Atlantis and causes lock contention and drift.
  `plan` and `init -backend=false && validate` are inspection only.
- **Never hardcode network facts.** Reference the SSOT files below.
- **Never put decrypted secrets in `docs/`.** The wiki is public. If `sops -d`
  touched it, it does not go in `docs/`.
- **Never commit to `main`.** Branch, PR, let CI and the operators do their job.
- A host config deployed from a branch **reverts on the next auto-upgrade** —
  hosts rebuild from `main`. Merge promptly or the change silently disappears.

## How changes ship

| Layer | Path | Applies when |
| --- | --- | --- |
| Terraform | Atlantis on the PR | autoplan on changed roots; comment `atlantis apply`; a successful apply automerges |
| Kubernetes | Flux | on merge to `main` |
| NixOS | `nixos-rebuild` | on deploy, and on each host's auto-upgrade from `main` |
| Wiki | `wiki.yml` → Cloudflare Pages | on merge to `main` |

See [Architecture/GitOps](docs/pages/Architecture___GitOps.md) for the full
picture of each path.

## Commands

**`mise` is the command source of truth.** Run `mise tasks ls` to see what
exists, then `mise run <task>`. Do not invent raw invocations when a task
exists — the task encodes the correct binary and flags.

Two things the tasks settle that are easy to get wrong:

- The Terraform binary is **`tofu` (OpenTofu)**, not `terraform`. Both are
  installed; OpenTofu is the apply path. The directory is still named
  `terraform/` — that is correct.
- Nix-specific workflows (`nixos-rebuild`, host builds, `nix flake check`) run
  through the Nix flake: `nix develop`.

For anything mise does not own — deploying to a live host, `sops`,
`flux reconcile` — the runbooks carry the exact invocation.

## Repo map

One line per top-level directory. Look in the tree for what is inside; this
file does not list contents.

| Path | What lives here |
| --- | --- |
| `nix/` | NixOS configuration for every host, plus image builds. Hosts are declared in `flake.nix`. |
| `clusters/` | Kubernetes manifests for `folly` (primary) and `offsite` (backup), with `base/` shared between them. |
| `terraform/` | All Terraform root modules — network fabric under `network/`, cloud and identity alongside it, reusable modules in `modules/`. |
| `apps/` | Deployable first-party services. |
| `packages/` | Reusable building blocks, including the Helm charts Flux consumes. |
| `images/` | Base and tool OCI images. |
| `dotfiles/` | mise-managed dotfiles, carried onto NixOS hosts by the system closure. |
| `docs/` | The Logseq graph published as the wiki. |
| `.agents/skills/` | Repo-local agent skills. Tool-agnostic source; `.claude/skills` is a symlink to it. |

## Single sources of truth

Do not restate these values anywhere — read them.

| Facts | Source |
| --- | --- |
| Cluster IPs/CIDRs, API-server endpoints, BGP ASNs | `clusters/<site>/config/cluster-topology.json` |
| Lab net CIDR and lab host IPs | `terraform/network/unifi/folly/lab.tf.json` |

Each topology JSON **is** the Flux ConfigMap, applied as-is — JSON is valid
YAML. Its `data` is flat `string→string` because Flux `substituteFrom` requires
it, so lists and numbers are encoded as strings. Flux substitutes `${VAR}` from
it; Nix reads it with `builtins.fromJSON`; Terraform roots consume it through
the `terraform/modules/cluster-topology` module. A conftest contract
(`.github/workflows/topology-contract.yml`) enforces the schema.

`lab.tf.json` is valid Terraform JSON auto-loaded by the folly UniFi root and
read by `nix/hosts/rackpi5.nix`.

## Where depth lives

- [Architecture](docs/pages/Architecture.md) — the layers and how they fit
  together.
- [Runbooks](docs/pages/Runbooks.md) — step-by-step operational procedures.
  Skills point here rather than restating them.
- [Fleet](docs/pages/Fleet.md) — every host, its hardware, and its quirks.
- `.agents/skills/` — task-scoped agent guidance. A skill carries a `runbook:`
  pointer in its frontmatter and holds only agent-specific notes; the runbook
  stays the canonical procedure.

Inside `docs/`, pages link each other with Logseq `[[wikilinks]]`. This file is
not part of the graph, so it uses paths.

## Writing rule for these docs

The previous docs rotted because they restated what the tree already says. When
you edit documentation:

1. **Present tense, today only.** Describe what is. No "formerly", "used to",
   "previously", "migrated from", "no longer". If a thing is gone, it does not
   appear — git history is the archaeology record. Honest current-state
   divergence with its blocker is fine and is not history.
2. **Point, don't restate.** Never enumerate what the tree enumerates. Name the
   directory. A list of modules or apps in prose is a list that will be wrong.
3. **Git is the truth; drift is a bug.** Document what the repo declares. Where
   reality diverges, say so in present tense with the blocker.
4. **Verify before you write.** Every path must exist, every command must match
   what the repo runs.

Run `mise run docs:check` before pushing docs. It enforces what a script can:
every wikilink resolves, every referenced repo path exists, and no past-tense
archaeology. It runs in CI and gates the wiki deploy. Rules 2 and 3 are on you —
no script catches "this list was right when it was written".

`docs/` is a Logseq graph: page properties are `key:: value` at the top of the
file, every block starts with `- `, nesting is tabs, and a `/` in a page name is
`___` in the filename. The renderer (`apps/wiki/build.ts`) supports outline
text, `[[wikilinks]]`, properties, `#tags`, tables, and code fences — **not**
block refs `((…))`, embeds, or `{{query}}`. Extend the renderer before using
those.
