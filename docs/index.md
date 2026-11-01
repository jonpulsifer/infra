---
title: Home
description: "The owner's homelab at two sites, folly and offsite, managed as code: its apps, platform, hosts and runbooks."
cards: [apps, platform]
---

This wiki explains how to use, operate and change the owner's homelab.
The [infra repository](https://github.com/jonpulsifer/infra) declares its configuration.

The lab has two sites: folly at home and offsite at a remote site.
Each site has a UniFi network and a Kubernetes cluster. Kubernetes nodes run Talos Linux.
NixOS hosts run supporting services. OpenTofu declares network and cloud resources.

## Learn the lab

1. Read [How changes ship](platform/how-changes-ship.md) to learn which controller applies each kind of change.
2. Read [Network](platform/network.md) to understand how the sites connect.
3. Read [Folly design](reference/folly-design.md) to understand node installation, identity and trust limits.
4. Read [fleetd](apps/fleetd.md) to learn how the node lifecycle controller works.
5. Use a [runbook](runbooks/index.md) when you need to perform a task.

The [glossary](reference/glossary.md) defines lab-specific terms.
The wiki is public. Each merge of `docs/` to `main` publishes it.

## Start here

- [Network](platform/network.md): the two sites and how they connect
- [Hosts](hosts/index.md): each machine, its job and how to reach it
- [Runbooks](runbooks/index.md): the procedures, grouped by area
- [Test a change](runbooks/test-a-change.md): the local check for each kind of change, before you open a pull request
- [Glossary](reference/glossary.md): the lab's own terms
- Connect an agent to [the wiki](runbooks/connect-an-agent-to-the-wiki.md) or to [kthx](runbooks/connect-an-agent-to-kthx.md): give an MCP client these pages, or the kthx tools
