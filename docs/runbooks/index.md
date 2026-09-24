---
title: Runbooks
description: Operational procedures for when things misbehave, served from Cloudflare so they stay readable during an outage.
---

Operational procedures for when things misbehave. These pages are served from Cloudflare, off the infrastructure they describe, so they stay readable during an outage.

## The runbooks

- [Deploy a NixOS host](deploy-a-nixos-host.md) — build, deploy, verify, and roll back NixOS hosts
- [Apply a Terraform change](apply-a-terraform-change.md) — Atlantis-first OpenTofu workflow and local validation
- [Apply a Kubernetes change](apply-a-kubernetes-change.md) — inspect Flux, reconcile resources, and handle SOPS safely
- [Operate Postgres](operate-postgres.md) — reach a CloudNativePG database through `kubectl cnpg`, and check whether it has a backup
- [Initialize OpenBao](initialize-openbao.md) — initialize and verify the folly OpenBao instance
- [Add a shared Kubernetes resource](add-a-shared-kubernetes-resource.md) — use the `clusters/base/` pattern for both clusters
- [Adopt the folly monitoring CRDs](adopt-the-folly-monitoring-crds.md) — stamp Helm ownership metadata onto folly's pre-existing Prometheus Operator CRDs before wiring `monitoring-crds`
- [Test a change](test-a-change.md) — validation commands by change area
- [Inspect the UniFi network](inspect-the-unifi-network.md) — read-only UniFi discovery before making changes
- [Manage SOPS secrets](manage-sops-secrets.md) — operator age key, harmonia keypairs, two-stage sops-nix recipient setup, decryption-failure triage
- [Get cluster admin access](get-cluster-admin-access.md) — JIT tokens for day-to-day kubectl, the break-glass certificate, and how to withdraw access
- [Repair a kiosk](repair-a-kiosk.md) — the Raspberry Pi kiosk hosts: Cage/Wayland, Firefox, container-backed apps
- [Adopt the folly Prometheus Operator CRDs](adopt-the-folly-prometheus-operator-crds.md) — the one-time live ownership stamp and Kustomization wiring that lets folly join `monitoring-crds`
- [Install kthx](install-kthx.md) — from nothing to an enrolled, Target-connected kthx installation: Terraform bootstrap, chart declaration, first-operator enrolment
- [Connect an agent to the wiki](connect-an-agent-to-the-wiki.md) — point Claude Desktop or any MCP client at `wiki.lolwtf.ca/mcp` so an agent can read the homelab docs
- [Connect an agent to kthx](connect-an-agent-to-kthx.md) — mint an agent token and point an MCP client at `spindrift-control.lolwtf.dev/mcp` to drive the platform
- [Authorize Developer Connect](authorize-developer-connect.md) — one-time browser authorization that moves the trusted-builds GitHub connection from PENDING_USER_OAUTH to COMPLETE
- [Install a Windows desktop](install-a-windows-desktop.md) — the Windows side of the desk: one-liner installer, winget desired state, the riced PowerShell profile, and why nothing symlinks across the WSL boundary
- [Install Windows monitoring](install-windows-monitoring.md) — the Windows desktops: windows_exporter, the sensor exporter that supplies the temperatures it cannot, and Event Log into VictoriaLogs
- [Flame Boss exporter](../apps/flameboss.md) — the barbecue as a monitoring target: how a cook reaches Prometheus from Flame Boss's cloud, why the dashboard is empty between cooks, and what each alert means
- [Operate the office phone](operate-the-office-phone.md) — the SPA504G's four lines through the folly PBX to voip.ms: health, provisioning the handset from git, reading the SIP, and the failure signatures that each call taught
- [Operate the Smiirl counter](operate-the-smiirl-counter.md) — check, calibrate and repair the Smiirl counter.
- [Repair the Rowbutt GitHub credential](repair-the-rowbutt-github-credential.md) — the GitHub App mate mints sandbox tokens from: the boot line, the readiness gauge, forcing a resync, rotating the private key, reinstalling the App, and why a sandbox cannot push

## Conventions

Lead with quick checks, then symptom-shaped sections ("If X…"), each with copy-pasteable commands and expected output.

Prefer `mise run <task>` where a task exists; it encodes the correct binary and flags. Give a raw invocation only where mise has no task — deploying to a live host, `sops`, `flux reconcile`.

Commands assume the reader is on the LAN or the tailnet. Note when a host needs a special path.

A runbook that changes desired state still ships through git — see [How changes ship](../platform/how-changes-ship.md).

Where an agent skill covers the same workflow, this page is the durable source. The skill carries a `runbook:` pointer in its frontmatter and holds only agent-specific guidance; it does not restate the procedure.

Do not symlink `SKILL.md` files into `docs/`. Skills are agent instructions, not wiki pages, and this site is public.
