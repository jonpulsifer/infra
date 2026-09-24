---
title: Hosts
description: Every host in the homelab, with its role, site, hardware, OS and status, and how to reach it.
---

The hosts are the machines the homelab runs on: Kubernetes nodes, Raspberry Pis, Windows desktops and a cloud VM. They are at two sites, folly (home) and offsite (remote). See [Network](../platform/network.md). `nix/hosts/default.nix` declares every NixOS host and image.

NixOS hosts rebuild from `main` once a day. The Pi 4 hosts have no auto-upgrade, and no Pi Zero runs its NixOS config. See [NixOS](../platform/nixos.md) and [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md).

| Host | Role | Site | Hardware | OS | Status |
| --- | --- | --- | --- | --- | --- |
| [optiplex](optiplex.md) | folly control plane and cluster CA | folly | Dell OptiPlex 3050 micro | NixOS | live |
| [riptide](riptide.md) | folly worker with a GPU, and folly build host | folly | HP EliteDesk 800 G5 Desktop Mini | NixOS | live |
| [shale](shale.md) | folly worker | folly | HP EliteDesk 800 G2 DM | NixOS | live |
| [retrofit](retrofit.md) | offsite control plane and cluster CA | offsite | HP EliteDesk 800 G2 DM | NixOS | live |
| [oldschool](oldschool.md) | offsite worker and yarr media downloads | offsite | HP EliteDesk 800 G3 DM | NixOS | live |
| [spore](spore.md) | NFS, x86 netboot, forge's boot image, DNS and NTP | folly | Raspberry Pi 5, NVMe | NixOS | live |
| [capsule](capsule.md) | DNS and NTP | folly | Raspberry Pi 5, NVMe | NixOS | live |
| [forge](forge.md) | arm64 build host | folly | Raspberry Pi 5, NVMe | NixOS | live |
| [rackpi5](rackpi5.md) | forge's HTTP boot image | folly | forge's board | NixOS | live |
| [cloudpi4](cloudpi4.md) | Test resolver and iperf3 server | folly | Raspberry Pi 4, 4 GB | NixOS | live |
| [homepi4](homepi4.md) | [Weather Hub](../apps/hub.md) kiosk | folly | Raspberry Pi 4, 7-inch touch display | NixOS | live |
| [weatherpi4](weatherpi4.md) | [Weather Hub](../apps/hub.md) kiosk | offsite | Raspberry Pi 4 | NixOS | live |
| [radiopi0](radiopi0.md) | LEDs driven by CloudEvents | folly | Raspberry Pi Zero W, pHAT BEAT | Raspbian 10 | off-git |
| [blinkypi0](blinkypi0.md) | LED strip | folly | Raspberry Pi Zero W, Blinkt! | Raspberry Pi OS Lite | unplugged |
| eviropico | Environment sensor | none | Pico W or Pico 2 W and a Pimoroni sensor pack (unverified) | MicroPython | unplugged |
| [tallboy](tallboy.md) | The owner's desktop | folly | ASUS ROG Strix G16CHR | Windows 11 Pro | live |
| [atomic](atomic.md) | Windows desktop | folly | unknown | Windows | unverified |
| [oldboy](oldboy.md) | Cloud VM that accumulates uptime | GCE, `homelab-ng` | e2-micro | NixOS | unverified |

## Reach a host

| Hosts | Name | Declared in |
| --- | --- | --- |
| folly nodes | `<host>.lolwtf.ca` | `static_records` in `terraform/network/unifi/folly/k8s.tf` |
| Hosts on [Lab Net](../platform/network.md#networks) | `<host>.lolwtf.ca` | The `lab` and `rpis` entries with an `ip` in `terraform/network/unifi/folly/clients.yaml` |
| offsite control plane | `offsite.lolwtf.ca` | `terraform/network/cloudflare/lolwtf.ca.tf`, from `API_SERVER_IP` in `clusters/offsite/config/cluster-topology.json` |
| Tailnet devices | `<host>.<tailnet>` | `terraform/network/tailscale/devices.tf`. `<tailnet>` is the `tailnet` key in `terraform/network/tailscale/fleet.tf.json`. |

The Kubernetes nodes run no Tailscale client. Off the LAN, the owner reaches them and Lab Net through each site's Connector. See [Remote access](../platform/network/remote-access.md).

## Known divergence

Each sheet states its host's divergence. These cover more than one host, or a host with no sheet:

- eviropico runs Pimoroni's MicroPython firmware, and no file in git holds its code. `clusters/folly/monitoring/picow.yaml` is a Pico W scrape target that folly does not apply, and may be eviropico's.
- `retrofit.lolwtf.ca` and `oldschool.lolwtf.ca` resolve, and no file in git declares them.
- capsule and forge are on the tailnet, and `devices.tf` lists neither. forge enrols through the OAuth client in `terraform/network/tailscale/oauth_clients.tf`.
- `devices.tf` lists nuc, with `tag:folly`, and desktop-g7i75ls, with `tag:offsite`. No sheet or NixOS configuration covers either.
- `devices.tf` lists the five Kubernetes nodes, which run no Tailscale client. Their tailnet names do not answer, and `dotfiles/.ssh/config` sends `ssh retrofit` and `ssh oldschool` to them.
