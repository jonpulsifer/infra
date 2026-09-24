# AGENTS.md

Multi-layer homelab managed as code: NixOS bare metal, two Kubernetes clusters,
Terraform-managed cloud and network fabric, first-party apps and images.

This file is a **router**, not a manual. It holds the rules you must know before
you touch anything, and pointers to where the depth lives. Depth lives in
`docs/` (published at [wiki.lolwtf.ca](https://wiki.lolwtf.ca)) and in
`.agents/skills/`.

## Hard rules

Read these before your first edit. They are prohibitions — routing you to them
after the fact is too late.

- **Never mutate live infrastructure by hand.** Author platform desired state
  in git and let the operators apply it. Spindrift is itself a declared
  controller: Flux owns its platform namespace and prerequisites; Spindrift
  owns resources in the `spindrift-apps` namespaces and inside pre-provisioned
  vessel projects through their APIs. That ownership boundary is declared in
  [Built apps](docs/apps/kthx/built-apps.md); it is not
  permission for an agent or operator to make the same changes out of band.
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

See [How changes ship](docs/platform/how-changes-ship.md) for the full
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

`mise` does not own the SOPS / age-key workflow. Start at
[Manage SOPS secrets](docs/runbooks/manage-sops-secrets.md); the matching skill
(`.agents/skills/sops-secrets/`) holds only the agent-side notes — the
runbook is the canonical procedure. The two facts that bite first-timers
hardest: the operator age key is at `~/.config/age/keys.txt` (NOT the
sops binary's default of `~/.config/sops/age/keys.txt`), and a fresh
sops file is two-stage — operator key as the only recipient at first,
host's own `ssh-to-age` recipient added after the first successful boot.

## Repo map

One line per top-level directory. Look in the tree for what is inside; this
file does not list contents.

| Path | What lives here |
| --- | --- |
| `nix/` | NixOS configuration for every host, plus image builds. Hosts are declared in `flake.nix`. |
| `clusters/` | Kubernetes manifests for the fully capable `folly` (on-site) and `offsite` (remote-site) clusters, with `base/` shared between them. |
| `terraform/` | All Terraform root modules — network fabric under `network/`, cloud and identity alongside it, reusable modules in `modules/`. |
| `apps/` | Deployable first-party services. |
| `packages/` | Reusable building blocks, including the Helm charts Flux consumes. |
| `images/` | Base and tool OCI images. |
| `dotfiles/` | mise-managed dotfiles, carried onto NixOS hosts by the system closure. |
| `docs/` | The Markdown pages published as the wiki; `docs/nav.yaml` orders the sidebar. |
| `.agents/skills/` | Repo-local agent skills. Tool-agnostic source; `.claude/skills` is a symlink to it. |

## Single sources of truth

Do not restate these values anywhere — read them.

| Facts | Source |
| --- | --- |
| Cluster IPs/CIDRs, API-server endpoints, BGP ASNs | `clusters/<site>/config/cluster-topology.json` |
| Lab/future CIDRs and lab host IPs | `clusters/folly/config/lab-topology.json` |

Each cluster topology JSON **is** the Flux ConfigMap, applied as-is — JSON is
valid YAML. Its `data` is flat `string→string` because Flux `substituteFrom`
requires it, so lists and numbers are encoded as strings. Flux substitutes
`${VAR}` from it; Nix reads it with `builtins.fromJSON`; Terraform roots consume
it through the `terraform/modules/cluster-topology` module. A conftest contract
(`.github/workflows/topology-contract.yml`) enforces the schema.

`clusters/folly/config/lab-topology.json` is also a flat-string Flux ConfigMap.
Flux substitutes its host addresses into folly storage and monitoring; Nix
projects it through `nix/lib/lab.nix`; the folly UniFi root reads it through the
same topology helper used for cluster ConfigMaps. Terraform preconditions keep
its selected host addresses aligned with `clients.yaml` DHCP reservations.

## Where depth lives

- [Platform](docs/platform/index.md) — the layers and how they fit together.
- [Apps](docs/apps/index.md) — pages for the first-party apps that have one.
- [Runbooks](docs/runbooks/index.md) — step-by-step operational procedures.
  Skills point here rather than restating them.
- [Hosts](docs/hosts/index.md) — every host, its hardware, and its quirks.
- `.agents/skills/` — task-scoped agent guidance. A skill carries a `runbook:`
  pointer in its frontmatter and holds only agent-specific notes; the runbook
  stays the canonical procedure.

Inside `docs/`, pages link each other with relative `.md` paths. This file is
not part of the site, so it uses repo-root paths.

## Agent skills

### sops-secrets

Working with `nix/secrets/*.sops.yaml` (operator and host decryption, harmonia keypair generation, two-stage recipient setup): see `.agents/skills/sops-secrets/SKILL.md` and [Manage SOPS secrets](docs/runbooks/manage-sops-secrets.md). The dev-machine operator key lives at `~/.config/age/keys.txt` and in 1Password (homelab vault, "sops homelab age key"); per-host recipients are derived from each host's ed25519 host key via `ssh-to-age`, which only works after the host has booted once.

### Issue tracker

Issues and PRDs live as **private** local markdown under `.agent/plans/` (gitignored) — the planning surface stays off the public repo; code and PRs stay public. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, written as `Status:` values on each ticket file (local tracker, not GitHub labels). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `AGENTS.md` router + the `docs/` wiki pages (no `CONTEXT.md`/ADR). See `docs/agents/domain.md`.

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
the renderer's own validation passes (frontmatter, nav, links, anchors,
images), every referenced repo path exists, there is no past-tense archaeology,
and every wiki URL or `docs/…md` path named in a Markdown file, a skill, or a
monitoring rule resolves to something the site serves, anchor included, with
no Logseq `[[Page]]` link left. It runs in CI and gates the wiki deploy.
Rules 2 and 3 are on you — no script catches "this list was right when it was
written".

`docs/` is plain GitHub Markdown in a folder tree that mirrors the URLs:
`docs/<section>/<page>.md` is `/<section>/<page>/`, an `index.md` is its
folder's URL, and file names are lowercase kebab-case. Every page opens with
YAML frontmatter carrying a `title` and a one-sentence `description`. The title
is the page's H1, so the body has no H1 and its sections start at `##`. Pages
link each other with relative `.md` paths (optionally with an `#anchor`) and
reference images in `docs/assets/`. `docs/nav.yaml` orders the sidebar, and a
page it does not list fails the build. `docs/agents/` is agent-facing and is
not rendered. The renderer (`apps/wiki/build.ts`) handles GitHub-flavoured
Markdown and `> [!NOTE]`-style alerts; extend it before using anything else.
