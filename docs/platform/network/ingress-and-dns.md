---
title: Ingress and DNS
description: The Gateways, DNS records, certificates, tunnels and lab resolvers that give cluster services a name and a path from the LAN, tailnet or internet.
---

Ingress gives a cluster service a Gateway address, a DNS name from external-dns and a certificate from cert-manager. Every app with a web address depends on it. The lab resolvers, capsule and spore, serve DNS and time to the lab networks.

## Parts

| Part | Job | Where it runs |
| --- | --- | --- |
| Gateway API | Sends requests for a hostname to a Service | Cilium in each cluster |
| cert-manager | Issues the Gateways' certificates from Let's Encrypt | Each cluster |
| external-dns | Publishes each route's name as a Cloudflare DNS record | Each cluster |
| Cloudflare Tunnels | Carry internet traffic into the clusters | cloudflared in each cluster |
| CoreDNS | Serves lab DNS with a blocklist | [capsule](../../hosts/capsule.md) and [spore](../../hosts/spore.md) |
| Chrony | Serves lab NTP time | capsule and spore |

## Private names

A Gateway is a Gateway API object that listens on its own load-balancer address (VIP). An HTTPRoute sends requests for a hostname on a Gateway to a Service. An app attaches an HTTPRoute to its cluster's shared `cluster-gateway`, or it declares its own Gateway.

folly's `cluster-gateway` has a `*.lolwtf.ca` listener with one wildcard certificate, and it admits routes from any namespace. On offsite, each HTTPS listener has a fixed hostname and admits routes from `default` or one named namespace. A new offsite app that shares the Gateway adds a listener with its hostname and an `allowedRoutes` namespace, or its route does not attach.

cert-manager issues the certificates from Let's Encrypt with the DNS-01 challenge, which proves control of a domain with a TXT record in Cloudflare.

external-dns publishes each route's name as an A record at its Gateway's VIP. The VIP is a private address, so the name works on the LAN, and over the tailnet for the owner (see [Remote access](remote-access.md)). external-dns runs with policy `sync`, so it deletes a record when its route is gone. `txtOwnerId` is `CLUSTER_NAME`, so each cluster deletes only its own records.

oauth2-proxy, the sign-in proxy in front of kthx Apps with `auth: proxy`, runs on both clusters. On offsite it has its own `oauth2-tls` listener on `cluster-gateway`, and its name is `oauth2` in the `SPINDRIFT_DOMAIN` zone.

Hosts resolve as `<host>.lolwtf.ca`. OpenTofu publishes these records in Cloudflare from `static_records` in `terraform/network/unifi/folly/k8s.tf`, and from each `lab` and `rpis` entry with an `ip` in `terraform/network/unifi/folly/clients.yaml`. `terraform/network/cloudflare/lolwtf.ca.tf` publishes each cluster's `API_SERVER_HOSTNAME`, `folly.lolwtf.ca` and `offsite.lolwtf.ca`, at its `API_SERVER_IP`.

`lolwtf.ca` holds these hand-managed records and is also a zone that kthx creates App names in, so both share one namespace.

## Public names

A Cloudflare Tunnel is an outbound connection from cloudflared in a cluster to Cloudflare, which sends matching internet requests back through it. Three tunnels carry internet traffic into the clusters. OpenTofu declares their ingress rules in `terraform/network/cloudflare/lolwtf.ca.tf` and `terraform/network/cloudflare/spindrift.tf`.

[kthx](../../apps/kthx.md) is the app platform. A kthx App is a service that kthx builds and deploys, and a quick site is a site published at `<name>.kthx.dev`.

| Tunnel | Runs on | Serves |
| --- | --- | --- |
| folly | folly | Nothing. It answers HTTP 418. |
| offsite | offsite | `tf.lolwtf.ca` for Atlantis |
| kthx Apps | offsite | Public kthx App names, quick sites, and the kthx control plane's GitHub webhook and [bosun](../../apps/bosun.md) outbox paths |

Each cluster that serves kthx Apps has an Apps Gateway, a Gateway with its own VIP for kthx App traffic only. A kthx App's `reach` sets its record. `private` publishes an A record at the Apps Gateway's VIP, with no Cloudflare proxy. `public` publishes a CNAME to the kthx Apps tunnel, through the Cloudflare proxy. [Built apps](../../apps/kthx/built-apps.md) describes reach and sign-in.

## Lab DNS and time

capsule and spore are the lab resolvers. DHCP on the Kubernetes, future and iot networks gives clients the addresses of both hosts. `dns.lolwtf.ca` and `time.lolwtf.ca` point at both hosts.

CoreDNS blocks the domains in the StevenBlack hosts list, and forwards other queries over TLS to Cloudflare's malware-blocking resolvers. It keeps no query log and serves Prometheus metrics on port 9253. It answers `api.smiirl.com` with folly's smiirl Gateway address for the [Smiirl counter](../../apps/smiirl.md). [cloudpi4](../../hosts/cloudpi4.md) runs the same config as a test resolver, and DHCP does not give out its address.

Chrony on both hosts syncs from NTS (Network Time Security) servers and polls the other host. If every upstream fails, Chrony's orphan mode makes one host the lab's time source.

## Rules

- Each DNS zone that kthx creates App names in needs an entry in four places. If one is missing, the App deploys without an error, but its name does not resolve or does not answer.
  - `domainFilters` in the external-dns HelmRelease
  - `dnsZones` in each cluster's `letsencrypt-production` issuer
  - A wildcard listener and certificate on the Apps Gateway of each cluster that serves the zone
  - For `reach: public`, a `*.<zone>` ingress rule on the kthx Apps tunnel in `terraform/network/cloudflare/spindrift.tf`
- Keep `--annotation-prefix` pinned in the external-dns HelmRelease. If the prefix does not match the objects, external-dns ignores their proxy and controller annotations.

## Where it lives

- `clusters/<site>/networking/gateway-api/`: the shared `cluster-gateway`
- `clusters/<site>/networking/cert-manager/issuers/`: the ClusterIssuers
- `clusters/folly/networking/cert-manager/certificates/`: folly's `*.lolwtf.ca` wildcard certificate
- `clusters/offsite/apps/spindrift/gateway.yaml` and `clusters/folly/apps/spindrift-target/gateway.yaml`: the kthx Apps Gateways
- `clusters/<site>/networking/external-dns/endpoints/gateway.yaml`: the `GATEWAY_DOMAIN` record at the UniFi gateway's addresses
- `clusters/base/networking/external-dns/helm-release.yaml`: external-dns settings and `domainFilters`
- `clusters/base/networking/cloudflare/`: the shared cloudflared Deployment. Each site's `clusters/<site>/networking/cloudflare/` adds its tunnel token from SOPS, and offsite's adds the kthx Apps tunnel with a token from 1Password.
- `clusters/base/cluster-settings.yaml`: `SPINDRIFT_DOMAIN`, the default DNS zone for kthx App names
- `terraform/network/cloudflare/`: the zones, the tunnels and the API server records
- `nix/services/coredns-sinkhole.nix` and `nix/services/ntp-server.nix`: the lab resolvers

## Related

- [Network](../network.md)
- [Remote access](remote-access.md)
- [Built apps](../../apps/kthx/built-apps.md)
