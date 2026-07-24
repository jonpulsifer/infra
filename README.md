# 🏠 Homelab Infrastructure

Infrastructure-as-code for a multi-layer homelab: NixOS bare metal, two
Kubernetes clusters, an OpenTofu-managed cloud and network fabric, and
GitOps-driven application deployments.

**📖 Full documentation: [wiki.lolwtf.ca](https://wiki.lolwtf.ca)** — built from
[`docs/`](./docs) in this repo and published on every merge to `main`.

## Layout

| Path | What lives here |
| --- | --- |
| [`nix/`](./nix) | NixOS configuration for every host, plus image builds. Hosts are declared in [`flake.nix`](./flake.nix). |
| [`clusters/`](./clusters) | Kubernetes manifests for `folly` (primary) and `offsite` (backup), with `base/` shared between them. |
| [`terraform/`](./terraform) | OpenTofu root modules — network fabric under `network/`, cloud and identity alongside it, reusable modules in `modules/`. |
| [`apps/`](./apps) | Deployable first-party services. |
| [`packages/`](./packages) | Reusable building blocks, including the Helm charts Flux consumes. |
| [`images/`](./images) | Base and tool OCI images. |
| [`dotfiles/`](./dotfiles) | mise-managed dotfiles, carried onto NixOS hosts by the system closure. |
| [`docs/`](./docs) | The Logseq graph published as the wiki. |

## Getting started

Tooling comes from [`mise`](https://mise.jdx.dev). Nix-specific workflows come
from the flake.

```bash
mise install      # portable tooling: OpenTofu, kubectl, flux, sops, helm, …
mise tasks ls     # every task this repo defines
nix develop       # Nix dev shell: nixos-rebuild and friends
```

`mise` is the source of truth for commands — prefer `mise run <task>` over raw
invocations, since the task encodes the correct binary and flags. Note that the
Terraform binary here is **`tofu`** (OpenTofu); the directory keeps the name
`terraform/`.

## How changes ship

This repo is GitOps-first. Author desired state in git and let the operators
apply it — do not mutate live infrastructure by hand.

| Layer | Applies via |
| --- | --- |
| OpenTofu | **Atlantis** on the PR — autoplan on changed roots, comment `atlantis apply` |
| Kubernetes | **Flux** on merge to `main` |
| NixOS | `nixos-rebuild`, and each host's auto-upgrade from `main` |

A host config deployed from a branch reverts on the next auto-upgrade. Merge
promptly.

See [Architecture/GitOps](./docs/pages/Architecture___GitOps.md) for the detail,
and [`AGENTS.md`](./AGENTS.md) if you are an agent working in this repo.

## Common tasks

```bash
# Build a host configuration without deploying
nix build .#nixosConfigurations.<hostname>.config.system.build.toplevel

# See every flake output, including image builds
nix flake show

# Validate everything CI validates
mise run tf:validate
nix flake check
```

Deploy procedures, cluster operations, and incident runbooks live in the
[Runbooks](https://wiki.lolwtf.ca/runbooks/).

## Security

Secrets are SOPS-encrypted in-repo with age, sourced from 1Password, and
decrypted on NixOS hosts by sops-nix using each host's own SSH host key.
OpenBao runs in the folly cluster with Raft storage and GCP KMS auto-unseal.
Network segmentation is enforced by UniFi; Tailscale provides the overlay.
