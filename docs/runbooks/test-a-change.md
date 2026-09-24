---
title: Test a change
description: The local commands that match what CI runs for each kind of change, to run before opening a PR.
---

Use this as the pre-PR validation index. Deeper workflows live in the linked runbooks.

## Docs and wiki

Build the wiki:

```bash
bun run --cwd apps/wiki build
```

Before pushing a docs change, run the docs contract:

```bash
mise run docs:check
```

It runs the renderer's validation (frontmatter, nav, links, anchors, images), so the build fails on any broken link inside `docs/`. It also resolves every wiki URL and `docs/` path the rest of the repo names (skills, READMEs and alert rules fail; code comments only warn) against the pages and anchors the site serves. The wiki keeps no redirects, so a page rename needs this check.

## Nix and NixOS

Full flake check:

```bash
nix flake check
```

Native x86 host build:

```bash
HOST=<hostname> mise run nix:build
```

Operator-run ARM host builds always use [forge](../hosts/forge.md). Select forge as the Nix store so evaluation inputs, substitutions, and builds stay on the builder:

```bash
NIX_REMOTE=ssh-ng://forge.lolwtf.ca HOST=<hostname> mise run nix:build
```

See [Deploy a NixOS host](deploy-a-nixos-host.md).

## Kubernetes

Build the kustomization root that includes the changed file:

```bash
kubectl kustomize clusters/<cluster>/<category>
```

For shared base changes, validate every consuming cluster:

```bash
kubectl kustomize clusters/folly/<category>
kubectl kustomize clusters/offsite/<category>
```

Run what CI runs, which renders both app overlays and then templates every in-repo chart their HelmReleases name, with that release's `.spec.values`:

```bash
mise run k8s:render-apps
```

A chart guard or template error is a failed task here rather than a failed Flux reconcile, so run it for a `packages/charts/` edit as well as a manifest edit. Charts served from a HelmRepository or OCIRepository are named and skipped.

See [Apply a Kubernetes change](apply-a-kubernetes-change.md) and [Add a shared Kubernetes resource](add-a-shared-kubernetes-resource.md).

## Terraform

The binary is **OpenTofu** (`tofu`), not `terraform`. Validate every root the same way CI does:

```bash
mise run tf:init
mise run tf:validate
```

Format:

```bash
mise run tf:fmt
```

See [Apply a Terraform change](apply-a-terraform-change.md).

## Secrets safety

Do not put decrypted SOPS values, API tokens, passwords, private keys, or one-time tokens in docs, PR comments, logs, or screenshots.

A crude docs scan before publishing sensitive-adjacent runbooks:

```bash
rg -n "op item|--reveal|password|token|private key|BEGIN .*KEY" docs
```

## Tooling

Prefer `mise` for portable validation tooling:

```bash
mise install
```

Use the Nix dev shell for NixOS-specific builds and formatters.
