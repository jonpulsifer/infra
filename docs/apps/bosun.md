---
title: Bosun
description: A Go daemon that keeps a warm pool of one-job GitHub Actions runners in Cloud Hypervisor microVMs. No host runs it.
status: parked
---

Bosun is a Go daemon, run as a NixOS service, that keeps GitHub Actions runners for this repository booted and waiting in microVMs. No host imports its module, so no runner from Bosun exists.

## Terms

| Term | Meaning |
| --- | --- |
| skiff | A Cloud Hypervisor microVM that runs one job and then halts |
| hull | The kernel, initrd and `hull.json` manifest that a skiff boots from |
| class | What a `runs-on:` label resolves to: a hull, vCPUs, memory, an optional scratch disk, and the number of warm skiffs |

## How it works

For each class, Bosun keeps a set number of skiffs booted. Each skiff registers with GitHub as a just-in-time (JIT) runner, and GitHub gives it a matching job. When a skiff halts, Bosun boots a replacement. Bosun has no inbound endpoint.

A job runs as root in the guest, and the microVM is the isolation boundary. Bosun passes the JIT config to the guest on a virtiofs share, and deletes it when the runner comes online. The systemd unit denies private, link-local and tailnet addresses to every skiff.

With `services.bosun.spindrift` set, Bosun also claims [kthx](kthx/built-apps.md) builds and boots a build hull for each claim.

## What is in the tree

- `apps/bosun/`: the daemon and its NixOS module. `.github/workflows/go.yml` runs its tests.
- To run Bosun, a host imports `apps/bosun/module.nix` and sets `services.bosun.enable` and `repo`. It sets `github.appId`, points `github.privateKeyFile` at the key in `nix/secrets/bosun.sops.yaml`, and declares a class. Add the host as a recipient of that file in `.sops.yaml` first.
- `nix/images/hull-*.nix`: the hulls, registered in `nix/hosts/default.nix`.
- Workflows in `.github/workflows/` that run on a skiff label wait for a runner that does not exist.
- `nix/secrets/bosun.sops.yaml`: Bosun's key on the GitHub App that Bosun shares with kthx.
- `terraform/network/cloudflare/spindrift.tf`: routes the Bosun build queue, `/internal/bosun/` on `spindrift-control.lolwtf.dev`, to the kthx engine.
- `clusters/base/monitoring/grafana-dashboards/bosun.json`: a dashboard on both clusters, with no data.
- `nix/hosts/riptide.nix` and `nix/hosts/oldschool.nix` delete `bosun.prom` from the node-exporter textfile directory.
