---
title: Ingress and DNS
description: The Gateways, DNS records, certificates, tunnels and lab resolvers that give cluster services a name and a path from the LAN, tailnet or internet.
---

Ingress gives a cluster service a Gateway address, a Cloudflare DNS name from external-dns and a Let's Encrypt certificate from cert-manager. The lab resolvers, [capsule](../../hosts/capsule.md) and [spore](../../hosts/spore.md), serve DNS and time to the lab networks.

## Private names

An app attaches an HTTPRoute to its cluster's shared `cluster-gateway`, or declares its own Gateway. folly's `cluster-gateway` has one `*.lolwtf.ca` wildcard listener that admits routes from any namespace. offsite's has one HTTPS listener for each hostname.

external-dns publishes each route's name as an A record at its Gateway's load-balancer address (VIP). The VIP is private, so the name works on the LAN, and over the [tailnet](remote-access.md) for the owner. With policy `sync` and `txtOwnerId` set to `CLUSTER_NAME`, each cluster deletes its own records when their routes go.

Hosts resolve as `<host>.lolwtf.ca`, from `static_records` in `terraform/network/unifi/folly/k8s.tf` and from each `lab` and `rpis` entry with an `ip` in `terraform/network/unifi/folly/clients.yaml`. `terraform/network/cloudflare/lolwtf.ca.tf` publishes each cluster's `API_SERVER_HOSTNAME`.

## Public names

| Cloudflare Tunnel | Runs on | Serves |
| --- | --- | --- |
| folly | folly | Nothing (HTTP 418) |
| offsite | offsite | `tf.lolwtf.ca` for Atlantis |
| kthx Apps | offsite | Public [kthx](../../apps/kthx.md) App names, quick sites at `<name>.kthx.dev`, the kthx GitHub webhook, and the [Bosun](../../apps/bosun.md) build queue at `/internal/bosun/` |

Each cluster that serves kthx Apps has an Apps Gateway with its own VIP. An App with `reach: private` gets an A record at that VIP, and `reach: public` gets a proxied CNAME to the kthx Apps tunnel.

## Lab DNS and time

DHCP on the Kubernetes, future and iot networks hands out capsule and spore as resolvers. `dns.lolwtf.ca` and `time.lolwtf.ca` point at both.

CoreDNS blocks the StevenBlack hosts list and forwards other queries over TLS to Cloudflare's malware-blocking resolvers. It answers `api.smiirl.com` with folly's smiirl Gateway address for the [Smiirl counter](../../apps/smiirl.md). [cloudpi4](../../hosts/cloudpi4.md) runs the same config as a test resolver.

Chrony syncs from NTS servers and polls the other host.

## Rules

- On offsite, an app that shares `cluster-gateway` adds a listener with its hostname and an `allowedRoutes` namespace, or its route does not attach.
- Each zone that kthx creates App names in needs a `domainFilters` entry in the external-dns HelmRelease, a `dnsZones` entry in each `letsencrypt-production` issuer, a wildcard listener and certificate on each serving Apps Gateway, and, for `reach: public`, a `*.<zone>` rule in `terraform/network/cloudflare/spindrift.tf`. Without one, the App deploys but its name does not resolve or answer.
- Keep `--annotation-prefix` pinned in the external-dns HelmRelease, or external-dns ignores the proxy and controller annotations.

## Where it lives

- `clusters/base/networking/` and `clusters/<site>/networking/`: `cluster-gateway`, issuers, external-dns and cloudflared
- `clusters/offsite/apps/spindrift/gateway.yaml` and `clusters/folly/apps/spindrift-target/gateway.yaml`: the Apps Gateways
- `clusters/base/cluster-settings.yaml`: `SPINDRIFT_DOMAIN`, the default zone for App names
- `terraform/network/cloudflare/`: the zones, tunnels and tunnel ingress rules
- `nix/services/coredns-sinkhole.nix` and `nix/services/ntp-server.nix`: the lab resolvers

## Related

- [Remote access](remote-access.md)
- [Built apps](../../apps/kthx/built-apps.md)
