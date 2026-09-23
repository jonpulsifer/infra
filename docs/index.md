---
title: Home
description: "A homelab managed as code: NixOS hosts, two Kubernetes clusters, OpenTofu for cloud and network, and first-party apps."
cards: [apps, platform]
---

## jonpulsifer/infra

Living documentation for a homelab managed entirely as code: NixOS bare metal, two Kubernetes clusters, an OpenTofu-managed cloud and network fabric, and GitOps-driven deployments. The source of truth is the [infra repository](https://github.com/jonpulsifer/infra); this wiki is its `docs/` directory, published on every merge to `main`.

## Start here

- [Platform](platform/index.md) — the four layers and how they fit together
- [Runbooks](runbooks/index.md) — operational procedures for when things misbehave
- [Hosts](hosts/index.md) — every host, its hardware, and its quirks
- [Connect an agent to the wiki](runbooks/connect-an-agent-to-the-wiki.md) — this wiki is also an MCP server at `wiki.lolwtf.ca/mcp`
- [Connect an agent to kthx](runbooks/connect-an-agent-to-kthx.md) — and kthx is one at `spindrift-control.lolwtf.dev/mcp`, authenticated and writing

## The stack in one breath

- **Bare metal** — [NixOS](platform/nixos.md) configuration for every host, deployed with `nixos-rebuild` and kept honest by auto-upgrades from `main`.
- **Kubernetes** — two fully capable clusters, `folly` on-site and `offsite` at the remote site, reconciled by FluxCD. See [Kubernetes](platform/kubernetes.md).
- **Cloud and network** — UniFi, Cloudflare, Tailscale, GCP and Google Workspace under [OpenTofu and Atlantis](platform/opentofu.md), with applies gated through Atlantis. The network fabric itself is [Network](platform/network.md).
- **Applications** — first-party services, packages and OCI images, described in [Build and release](platform/build-and-release.md).

Everything ships the same way: open a PR and let the operators apply it. See [How changes ship](platform/how-changes-ship.md).

## House rules

Author desired state in git. Never mutate live infrastructure by hand.

Network facts come from the `cluster-topology` single source of truth. Reference it; never copy values out of it.

Secrets are SOPS-encrypted in the repository. **This site is public** — nothing decrypted ever lands here. See [Secrets and PKI](platform/secrets-and-pki.md).

## Editing

These pages are the `docs/` directory of the repo. Editing is a normal PR; merging to `main` publishes to [wiki.lolwtf.ca](https://wiki.lolwtf.ca).

Pages are GitHub Markdown with YAML frontmatter at the top, in a folder tree that mirrors the URL; `docs/nav.yaml` sets the sidebar order.

The renderer supports GitHub Markdown — tables, task lists, code fences and alerts — and links pages by relative `.md` path. Extend `apps/wiki/build.ts` before reaching for anything else.

Write in the present tense about what is true today. Git history is the record of what changed; these pages are not.
