# infra

Infrastructure as code for a homelab: NixOS hosts, two Kubernetes clusters,
OpenTofu for the cloud and the network, and first-party apps. The
[wiki](https://wiki.lolwtf.ca) documents it. Its source is [`docs/`](./docs),
and each merge to `main` publishes it.

## Layout

| Path | What lives here |
| --- | --- |
| [`nix/`](./nix) | NixOS configuration for every host, and image builds. [`flake.nix`](./flake.nix) declares the hosts. |
| [`clusters/`](./clusters) | Kubernetes manifests for the `folly` (on-site) and `offsite` (remote-site) clusters. `base/` holds what both clusters run. |
| [`terraform/`](./terraform) | OpenTofu root modules. The network is under `network/`, and reusable modules are in `modules/`. |
| [`apps/`](./apps) | First-party services and tools. |
| [`packages/`](./packages) | Shared libraries, and the Helm charts that Flux installs. |
| [`images/`](./images) | Base and tool OCI images. |
| [`dotfiles/`](./dotfiles) | Shell, editor and agent configuration. NixOS hosts install it on each activation. |
| [`docs/`](./docs) | The wiki pages. |

## Get started

```bash
mise install        # OpenTofu, kubectl, flux, sops, helm and the other tools
mise tasks ls       # every task in this repo
mise run devshell   # the Nix dev shell, for nixos-rebuild and host builds
bun install         # the Bun workspace in apps/ and packages/
```

When a mise task exists, use `mise run <task>`. The task has the correct binary
and flags. The Terraform binary is `tofu` (OpenTofu), in the directory
`terraform/`.

## Validate a change

```bash
HOST=<host> mise run nix:build   # build the closure of one host without deploying it
mise run nix:check               # evaluate every host
mise run tf:validate             # validate the OpenTofu roots
mise run ts:check                # typecheck and lint the Bun workspace
mise run docs:check              # build the wiki and check links into it
```

[Test a change](https://wiki.lolwtf.ca/runbooks/test-a-change/) has the rest.

## How changes ship

Change the desired state in git. Do not change live infrastructure by hand.

| Layer | Applies through |
| --- | --- |
| OpenTofu | Atlantis on the pull request. It plans each changed root, and the comment `atlantis apply` applies it. |
| Kubernetes | Flux, on merge to `main` |
| NixOS | `nixos-rebuild`, and the auto-upgrade from `main` |

Auto-upgrade rebuilds a host from `main` and removes a configuration deployed
from a branch, so merge a deployed branch promptly.
[How changes ship](https://wiki.lolwtf.ca/platform/how-changes-ship/) has the
detail, and [Secrets](https://wiki.lolwtf.ca/platform/secrets/) explains the
SOPS files. Agents read [`AGENTS.md`](./AGENTS.md) first.
