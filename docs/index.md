---
title: Home
description: "The owner's homelab at two sites, folly and offsite, managed as code: its apps, platform, hosts and runbooks."
cards: [apps, platform]
---

This wiki documents the owner's homelab, which the [infra repository](https://github.com/jonpulsifer/infra) manages as code. The lab has two sites: folly at home and offsite at a remote site. Each site has a UniFi network and a Kubernetes cluster on NixOS hosts, and OpenTofu declares the network and cloud accounts. The owner and agents use these pages to run and change the lab. The wiki is public, and each merge of `docs/` to `main` publishes it.

## Start here

- [Network](platform/network.md): the two sites and how they connect
- [Hosts](hosts/index.md): each machine, its job and how to reach it
- [Runbooks](runbooks/index.md): the procedures, grouped by area
- [Test a change](runbooks/test-a-change.md): the local check for each kind of change, before you open a pull request
- [Glossary](reference/glossary.md): the lab's own terms
- Connect an agent to [the wiki](runbooks/connect-an-agent-to-the-wiki.md) or to [kthx](runbooks/connect-an-agent-to-kthx.md): give an MCP client these pages, or the kthx tools
