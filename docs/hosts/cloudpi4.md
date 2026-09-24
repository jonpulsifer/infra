---
title: cloudpi4
description: A wired Raspberry Pi 4 at folly that is a test DNS resolver and an iperf3 server.
specs:
  vendor: Raspberry Pi
  model: Raspberry Pi 4 Model B Rev 1.1 (4 GB)
  serial: 100000009c1080f8
  revision: c03111
  cpu: BCM2711, Cortex-A72 (4c)
  ram: 4 GB LPDDR4-3200
  gpu: Broadcom VideoCore VI
  storage: 64 GB microSD
  os: NixOS 26.05 (Yarara)
---

cloudpi4 is a wired Raspberry Pi 4 on [Lab Net](../platform/network.md#networks), folly's network for lab hosts. It is a test DNS resolver and an iperf3 server. `nix/hosts/cloudpi4.nix` configures it.

## What it runs

- CoreDNS with the resolver config of capsule and spore, from `nix/services/coredns-sinkhole.nix`. DHCP does not offer cloudpi4 as a DNS server, so it answers only clients configured to use it. See [Lab DNS and time](../platform/network/ingress-and-dns.md#lab-dns-and-time).
- An iperf3 server for [netbench](../apps/netbench.md)
- A node exporter, which `clusters/folly/monitoring/local-node-exporters.yaml` declares as a Prometheus target on folly

## Reach

Reach it at `cloudpi4.lolwtf.ca` or [`cloudpi4.<tailnet>`](index.md#reach-a-host).

## Quirks

- cloudpi4 has no auto-upgrade. Deploy it with [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md).
