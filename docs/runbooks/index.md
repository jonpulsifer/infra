---
title: Runbooks
description: Step-by-step procedures for the hosts, clusters, network, secrets and apps, grouped by area.
---

Runbooks are the step-by-step procedures that the owner and agents follow to change, check or repair the lab. The wiki is on Cloudflare Pages, outside the lab, so the runbooks stay readable when the lab is down.

## Hosts

- [Deploy a NixOS host](deploy-a-nixos-host.md): deploy a host's configuration, restore its previous generation, or rename a node's partitions
- [Add a Kubernetes node](add-a-kubernetes-node.md): declare a new x86_64 node and install it
- [Change the forge EEPROM](change-the-forge-eeprom.md): change forge's boot settings and keep its HTTP boot fallback
- [Install a Windows desktop](install-a-windows-desktop.md): install and update the owner's Windows configuration
- [Install Windows monitoring](install-windows-monitoring.md): add a desktop to folly's Prometheus and repair its agents

## Kubernetes

- [Apply a Kubernetes change](apply-a-kubernetes-change.md): change `clusters/`, share a resource between the clusters, and make sure Flux applies it
- [Get cluster admin access](get-cluster-admin-access.md): get `kubectl` access, use the break-glass certificate, and withdraw access
- [Operate Postgres](operate-postgres.md): connect to, inspect and restart the CloudNativePG databases
- [Adopt the folly Prometheus Operator CRDs](adopt-the-folly-prometheus-operator-crds.md): move folly's Prometheus Operator CRDs to a HelmRelease, so that chart bumps upgrade them

## Cloud and network

- [Apply an OpenTofu change](apply-an-opentofu-change.md): change a root, check it, and apply it through Atlantis
- [Authorize Developer Connect](authorize-developer-connect.md): authorize the GitHub connection of the trusted-builds project
- [Inspect the UniFi network](inspect-the-unifi-network.md): read the live state of a UniFi console and compare it with git

## Secrets

- [Manage SOPS secrets](manage-sops-secrets.md): restore the operator age key, edit a SOPS file, add a host, and rotate the key
- [Initialize OpenBao](initialize-openbao.md): initialize a new OpenBao instance and store its recovery key

## Apps

- [Install kthx](install-kthx.md): install the kthx engine on the offsite cluster
- [Connect an agent to kthx](connect-an-agent-to-kthx.md): mint an agent token and connect an MCP client
- [Repair the Rowbutt GitHub credential](repair-the-rowbutt-github-credential.md): check, rotate and replace the GitHub App credential of Rowbutt
- [Operate the Smiirl counter](operate-the-smiirl-counter.md): check, calibrate and repair the Smiirl counter
- [Operate the Flame Boss exporter](operate-the-flame-boss-exporter.md): check a cook, act on its alerts, and replace the Flame Boss token
- [Repair a kiosk](repair-a-kiosk.md): restart or start a Weather Hub kiosk
- [Connect an agent to the wiki](connect-an-agent-to-the-wiki.md): add the wiki's MCP endpoint to an MCP client
- [Operate the office phone](operate-the-office-phone.md): check, change and debug the office phone and the folly PBX
- [Screen callers on the office phone](screen-callers-on-the-office-phone.md): add a contact who skips the press-5 screen, use the star codes, and render the prompts

## Every change

- [Test a change](test-a-change.md): run the local check for each kind of change before you open a pull request
