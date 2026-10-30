---
title: Ingress and DNS
description: The Gateways, DNS records, certificates, tunnels and lab resolvers that give cluster services a name and a path from the LAN, tailnet or internet.
---

Ingress gives a cluster service a Gateway address, a Cloudflare DNS name from external-dns and a Let's Encrypt certificate from cert-manager. The lab resolvers, [capsule](../../hosts/capsule.md) and [spore](../../hosts/spore.md), serve DNS and time to the lab networks.

## Private names

An app attaches an HTTPRoute to its cluster's shared `cluster-gateway`, or declares its own Gateway. folly's `cluster-gateway` has one `*.lolwtf.ca` wildcard listener that admits routes from any namespace. offsite's has one HTTPS listener for each hostname.

external-dns publishes each route's name as an A record at its Gateway's load-balancer address (VIP). The VIP is private, so the name works on the LAN, and over the [tailnet](remote-access.md) for the owner. With policy `sync` and `txtOwnerId` set to `CLUSTER_NAME`, each cluster deletes its own records when their routes go.

Hosts resolve as `<host>.lolwtf.ca`. The Kubernetes nodes come from `NODE_ADDRESSES` in each cluster's [topology file](../../reference/topology.md): folly's through `static_records` in `terraform/network/unifi/folly/k8s.tf`, offsite's through `terraform/network/cloudflare/lolwtf.ca.tf`, which also publishes each cluster's `API_SERVER_HOSTNAME`. Lab hosts come from each `lab` and `rpis` entry with an `ip` in `terraform/network/unifi/folly/clients.yaml`.

## Public names

| Cloudflare Tunnel | Runs on | Serves |
| --- | --- | --- |
| folly | folly | `spire.lolwtf.ca` on `/.well-known/openid-configuration` and `/keys`, the SPIRE discovery documents that GCP reads. See [Identity](../identity.md). |
| offsite | offsite | `tf.lolwtf.ca` for Atlantis, and `voice.lolwtf.ca` on `/speech-engine` for ElevenLabs Speech Engine to reach mate, which verifies each connection's JWT |
| kthx Apps | offsite | Public [kthx](../../apps/kthx.md) App names, quick sites at `<name>.kthx.dev`, the kthx GitHub webhook, and the [Bosun](../../apps/bosun.md) build queue at `/internal/bosun/` |

Each cluster that serves kthx Apps has an Apps Gateway with its own VIP. An App with `reach: private` gets an A record at that VIP, and `reach: public` gets a proxied CNAME to the kthx Apps tunnel.

## Lab DNS and time

[capsule](../../hosts/capsule.md), [spore](../../hosts/spore.md) and [forge](../../hosts/forge.md) are the three anchors. Each runs CoreDNS and chrony through `nix/profiles/anchor.nix`.

Two shared addresses, `ns1.lolwtf.ca` and `ns2.lolwtf.ca` (`NS1_IP` and `NS2_IP` in `clusters/folly/config/anchor-topology.json`), make the three one service. keepalived on every anchor runs unicast VRRP for both, from `nix/services/anchor-vips.nix`. ns1 prefers capsule, then forge, then spore; ns2 prefers forge, then spore, then capsule. An anchor whose CoreDNS stops answering drops below every healthy anchor, so the address moves to one that answers. `AnchorVipDown` fires when an address has no holder or its CoreDNS is down. `s3.lolwtf.ca` (`S3_VIP`) fronts the anchors' Garage S3 API, held on capsule, then forge, then spore; a Garage that lacks a quorum or stops answering S3 drops its anchor below the healthy ones, and `AnchorS3VipDown` fires when no anchor serves it. A further address, `BOOT_VIP`, serves [Talos boot](../nixos/talos-boot.md) on the bootstrap VLAN.

DHCP on the Kubernetes, future and iot networks hands out ns1 and ns2 as resolvers, `dns.lolwtf.ca` and `time.lolwtf.ca` point at them, and folly's Talos nodes take time from them (`TimeSyncConfig` in `clusters/folly/talos/patches.tf`). DHCP on the bootstrap VLAN names each anchor's bootstrap address as a resolver and `BOOT_VIP` as its time server. NixOS hosts keep their own time servers (`networking.timeServers` in `nix/profiles/fleet.nix`).

CoreDNS blocks the StevenBlack hosts list and forwards other queries over TLS to Cloudflare's malware-blocking resolvers. It answers `api.smiirl.com` with folly's smiirl Gateway address for the [Smiirl counter](../../apps/smiirl.md). [cloudpi4](../../hosts/cloudpi4.md) runs the same config as a test resolver.

Chrony syncs from NTS servers and polls the other two anchors.

## Rules

- On offsite, an app that shares `cluster-gateway` adds a listener with its hostname and an `allowedRoutes` namespace, or its route does not attach.
- Each zone that kthx creates App names in needs a `domainFilters` entry in the external-dns HelmRelease, a `dnsZones` entry in each `letsencrypt-production` issuer, a wildcard listener and certificate on each serving Apps Gateway, and, for `reach: public`, a `*.<zone>` rule in `terraform/network/cloudflare/kthx-engine.tf`. Without one, the App deploys but its name does not resolve or answer.
- Keep `--annotation-prefix` pinned in the external-dns HelmRelease, or external-dns ignores the proxy and controller annotations.

## Where it lives

- `clusters/base/networking/` and `clusters/<site>/networking/`: `cluster-gateway`, issuers, external-dns and cloudflared
- `clusters/offsite/apps/kthx-engine/gateway.yaml` and `clusters/folly/apps/kthx-engine-target/gateway.yaml`: the Apps Gateways
- `clusters/base/cluster-settings.yaml`: `KTHX_ENGINE_DOMAIN`, the default zone for App names
- `terraform/network/cloudflare/`: the zones, tunnels and tunnel ingress rules
- `nix/services/coredns-sinkhole.nix` and `nix/services/ntp-server.nix`: the lab resolvers

## Related

- [Remote access](remote-access.md)
- [Built apps](../../apps/kthx/built-apps.md)
