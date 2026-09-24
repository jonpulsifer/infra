# AGENTS.md

This repository is a homelab managed as code. It holds the NixOS hosts, two
Kubernetes clusters, OpenTofu for the cloud and the network, and first-party
apps and images. `folly` is the cluster at home, and `offsite` is the cluster at
a remote site. The wiki at [wiki.lolwtf.ca](https://wiki.lolwtf.ca) is built
from `docs/`.

This file holds the rules to know before your first edit and points to the
detail in `docs/` and `.agents/skills/`.

The owner is the human who runs this lab. A controller is named for what it
is, such as Flux or Atlantis. kthx is the lab's hosting product. Its engine,
`apps/spindrift`, is a controller that builds and deploys each built app.

## Hard rules

- Change live infrastructure only through git. Author the desired state here,
  and Flux, Atlantis and the host rebuilds apply it. Change live state by hand
  only when the owner asks, even when a runbook has the steps.
- Flux owns the kthx engine's namespace and prerequisites. The engine owns each
  built app's `app-<name>` namespace and DNS records. It also owns the app's
  releases in `spindrift-apps`, its Argo `Application` objects in `argo` on
  folly, and its Datastores in `spindrift-datastores`. In the cloud projects
  and accounts the engine is given, it owns the app's resources.
  [Ownership and security](docs/apps/kthx/security.md) declares this boundary.
  Nobody makes these changes by hand.
- Never `kubectl apply` to author state. Use `kubectl`, `flux get` and
  `flux reconcile` to inspect or to force a sync.
- Never run `tofu apply` against remote state. Atlantis applies on the PR, and
  a local apply races it for the state lock. `plan`, and
  `init -backend=false` with `validate`, are inspection only.
- Never copy a network fact such as an address, a subnet or an ASN. Read it from
  a [single source of truth](#single-sources-of-truth).
- Never put a decrypted secret in `docs/`, a commit, a PR or a log. The repo and
  the wiki are public. If `sops -d` produced it, it stays out.
- Never commit to `main`. Open a branch and a PR, and let CI, Atlantis and Flux
  apply it.
- A host configuration deployed from a branch reverts at the host's next
  auto-upgrade, which rebuilds from `main` every day. Merge the change promptly.
  The Pi 4 hosts have no auto-upgrade and change only when deployed. No Pi Zero
  runs its NixOS config.

## How changes ship

| Layer | Applies through | When |
| --- | --- | --- |
| OpenTofu | Atlantis on the PR | Atlantis plans the changed roots. A comment of `atlantis apply` applies them and merges the PR. |
| Kubernetes | Flux | After a merge to `main` |
| NixOS | `nixos-rebuild` | On a deploy, and at the daily auto-upgrade from `main` on hosts that have one |
| Wiki | `.github/workflows/wiki.yml` to Cloudflare Pages | After a merge to `main` |

[How changes ship](docs/platform/how-changes-ship.md) has each path and its
exceptions.

## Commands

`mise` is the command source of truth. Run `mise tasks ls`, then
`mise run <task>`. A task encodes the correct binary and flags, so use it when
one exists.

- The OpenTofu binary is `tofu`. The directory is named `terraform/`.
- Nix work (`nixos-rebuild`, host builds, `nix flake check`) runs in the dev
  shell: `mise run devshell`.
- Host deploys, `sops` and `flux reconcile` have no task. The runbooks carry
  the commands.
- The operator key, the owner's age key, is at `~/.config/age/keys.txt`, so set
  `SOPS_AGE_KEY_FILE` to that path. The `sops-secrets` skill and
  [Manage SOPS secrets](docs/runbooks/manage-sops-secrets.md) cover the rest.

## Repo map

| Path | What is there |
| --- | --- |
| `nix/` | NixOS configuration for every host, and the image builds. Hosts are declared in `nix/hosts/default.nix`. |
| `clusters/` | Kubernetes manifests for `folly` and `offsite`. `clusters/base/` is shared by both. |
| `terraform/` | OpenTofu root modules, with the network under `network/` and reusable modules under `modules/`. Each `clusters/<site>/bootstrap/` is a root too. |
| `apps/` | First-party services and tools. |
| `packages/` | Shared libraries and the Helm charts Flux installs. |
| `images/` | Base and tool OCI images. |
| `dotfiles/` | mise-managed dotfiles. NixOS hosts carry them in the system closure. It has its own `AGENTS.md`. |
| `docs/` | The wiki pages. `docs/nav.yaml` orders the sidebar. |
| `.agents/skills/` | Repo agent skills. `.claude/skills` is a symlink to it. |

## Single sources of truth

Read these values from their file. Do not copy them.

| Facts | Source |
| --- | --- |
| Cluster addresses and CIDRs, API server endpoints, BGP ASNs | `clusters/<site>/config/cluster-topology.json` |
| Lab CIDR, the CIDR of folly's `future` network, and lab host addresses | `clusters/folly/config/lab-topology.json` |

Each file is a Flux ConfigMap whose `data` values are all strings, so a list or
a number is written as a string. [Topology](docs/reference/topology.md) says
what reads each file.

## Where to read more

- [Platform](docs/platform/index.md): the shared systems.
- [Apps](docs/apps/index.md): one page for each first-party service.
- [Hosts](docs/hosts/index.md): one sheet for each machine.
- [Runbooks](docs/runbooks/index.md): the canonical procedures.
- [Reference](docs/reference/index.md): the style guide, the glossary and the
  topology keys.
- `.agents/skills/`: agent notes for one task. A skill that has a runbook
  names it in `metadata.runbook` and holds only what an agent needs beyond it.

Pages in `docs/` link each other with relative `.md` paths.

## Agent skills

### Issue tracker

Specs and tickets are private Markdown files under `.agent/plans/`, which are
never committed. See `docs/agents/issue-tracker.md`.

### Triage labels

A ticket's triage label is the value on its `Status:` line. See
`docs/agents/triage-labels.md`.

### Domain docs

The domain documentation is this file and the wiki in `docs/`. The repo has no
`CONTEXT.md` and no ADRs. See `docs/agents/domain.md`.

## Writing rule for these docs

[The style guide](docs/reference/style-guide.md) sets the voice, the page
templates and the word budgets. Four rules keep the docs true:

1. Write in the present tense about today. Git history records what changed.
2. Point at the tree. Name the directory, file or key; never copy a list the
   tree holds.
3. Git is the truth and drift is a bug. Document what the repo declares. Where
   live state differs, say so in the present tense and name the blocker.
4. Verify before you write. Every path exists and every command matches what
   the repo runs.

Run `mise run docs:check` before you push a docs change. It runs the
renderer's checks, rejects past-tense words, and resolves each path and wiki
URL that the docs, a skill or an alert rule names. CI runs it before the wiki
deploys. No script checks rules 2 and 3.

`docs/<section>/<page>.md` is served at `/<section>/<page>/`. The renderer,
`apps/wiki/build.ts`, handles GitHub-flavoured Markdown and `> [!NOTE]` alerts;
extend it before you use other syntax. `docs/agents/` is for agents and is not
rendered.
