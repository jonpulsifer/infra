---
title: Glossary
description: The lab-specific terms that the wiki pages use, what each means, and the page that defines it.
---

This page defines the lab's own terms, and the tool terms that have a lab-specific meaning. Each row links to the page that explains the term.

| Term | Meaning | Page |
| --- | --- | --- |
| Agent token | A 90-day credential that lets an agent call the kthx MCP endpoint | [Connect an agent to kthx](../runbooks/connect-an-agent-to-kthx.md) |
| App | In kthx, a source and the Components deployed from it | [Built apps](../apps/kthx/built-apps.md#concepts) |
| Apps Gateway | The Gateway, with its own VIP, that serves kthx Apps on a cluster | [Ingress and DNS](../platform/network/ingress-and-dns.md#public-names) |
| ARC | Actions Runner Controller, which runs the self-hosted GitHub Actions runners | [Build and release](../platform/build-and-release.md) |
| Artifact | What a kthx Build produces: an image digest or a file tree | [Built apps](../apps/kthx/built-apps.md#concepts) |
| Atlantis | The server on offsite that plans and applies OpenTofu from pull requests | [OpenTofu and Atlantis](../platform/opentofu.md#atlantis) |
| Auto-upgrade | The daily rebuild of a NixOS host from `main` | [NixOS](../platform/nixos.md#auto-upgrade) |
| bluenose | The GCP project that holds kthx's storage and identities, and its default Vessel | [Cloud accounts](../platform/cloud.md#google-cloud) |
| Bootstrap root | The OpenTofu root in `clusters/<site>/bootstrap/` that installs Flux on a cluster | [How changes ship](../platform/how-changes-ship.md#kubernetes) |
| Break-glass certificate | A `system:masters` client certificate for use when tokens fail | [Get cluster admin access](../runbooks/get-cluster-admin-access.md#use-the-break-glass-certificate) |
| Build | One run of a kthx build route | [Built apps](../apps/kthx/built-apps.md#builds) |
| Build host | The machine that builds a NixOS closure before a deploy | [Build host and cache](../platform/nixos/build-host-and-cache.md) |
| Build route | Where a kthx Build runs, chosen by its SLSA level | [Built apps](../apps/kthx/built-apps.md#builds) |
| Built app | An App that kthx builds from a repository or archive, signs and deploys | [Built apps](../apps/kthx/built-apps.md) |
| cathy | The office phone, a Cisco SPA504G | [PBX](../apps/pbx.md) |
| CD digest PR | The pull request that pins a newly built image digest in its manifests | [Build and release](../platform/build-and-release.md#continuous-delivery) |
| Class | In Bosun, what a `runs-on:` label resolves to | [Bosun](../apps/bosun.md#terms) |
| Cluster CA | The FML certificate authority of one Kubernetes cluster | [PKI](../platform/pki.md#chain) |
| `cluster-gateway` | The shared Gateway that apps on a cluster attach routes to | [Ingress and DNS](../platform/network/ingress-and-dns.md#private-names) |
| Component | A `service`, `website` or `job` in a kthx App | [Built apps](../apps/kthx/built-apps.md#concepts) |
| Connector | The Tailscale Connector that routes tailnet traffic into a site | [Remote access](../platform/network/remote-access.md) |
| Datastore | A Postgres or Valkey instance that kthx gives to Apps | [Built apps](../apps/kthx/built-apps.md#concepts) |
| Deploy | A kthx Artifact and config applied to a Target | [Built apps](../apps/kthx/built-apps.md#concepts) |
| Fleet baseline | The NixOS modules of each deployable host | [NixOS](../platform/nixos.md) |
| Flux Kustomization | A Flux object that applies one directory of `clusters/` | [Kubernetes](../platform/kubernetes.md#how-state-reaches-a-cluster) |
| FML | Folly Mountain Laboratories, the name of the lab's private certificate chain | [PKI](../platform/pki.md) |
| `fml` | offsite's console name for folly, and folly's home WLAN | [Network](../platform/network.md) |
| folly | The home site and its Kubernetes cluster | [Network](../platform/network.md) |
| Function | In kthx, a JavaScript `fetch` handler on Workers or Cloud Run | [Built apps](../apps/kthx/built-apps.md#concepts) |
| `future` | The folly network with an IPv6 prefix from the WAN | [Network](../platform/network.md#networks) |
| Generation | One build of a NixOS system that a host keeps and can switch back to | [Deploy a NixOS host](../runbooks/deploy-a-nixos-host.md#restore-the-previous-generation) |
| GitOps rule | The rule that nobody changes live state by hand | [How changes ship](../platform/how-changes-ship.md) |
| Host recipient | The age key of a host, derived from its SSH host key | [Secrets](../platform/secrets.md#keys-and-recipients) |
| Hull | The kernel, initrd and manifest that a skiff boots from | [Bosun](../apps/bosun.md#terms) |
| `infra` GitRepository | Flux's copy of this repository | [How changes ship](../platform/how-changes-ship.md#kubernetes) |
| kthx | The lab's hosting product, with quick sites and built apps | [kthx](../apps/kthx.md) |
| kthx Apps tunnel | The Cloudflare Tunnel named `spindrift`, for public kthx names | [Ingress and DNS](../platform/network/ingress-and-dns.md#public-names) |
| kthx engine | The controller in `apps/spindrift` that builds and deploys built apps | [kthx](../apps/kthx.md#how-it-works) |
| Lab Net | The folly network for lab hosts | [Network](../platform/network.md#networks) |
| Lab resolvers | capsule and spore, which serve lab DNS and time | [Ingress and DNS](../platform/network/ingress-and-dns.md#lab-dns-and-time) |
| mate | The code name and process of Rowbutt | [How Rowbutt works](../apps/mate/how-it-works.md) |
| `nest` | folly's console name for offsite | [Network](../platform/network.md) |
| offsite | The remote site and its Kubernetes cluster | [Network](../platform/network.md) |
| Operator key | The owner's age key, a recipient of every SOPS file | [Secrets](../platform/secrets.md#keys-and-recipients) |
| Owner | The human who runs the lab. Pages name each controller, such as Flux. | [Style guide](style-guide.md#voice) |
| Quick site | A directory that kthx serves at `<name>.kthx.dev` | [Quick sites](../apps/kthx/sites.md) |
| rackpi5 | The NixOS image that forge boots over HTTP when its NVMe does not boot | [rackpi5](../hosts/rackpi5.md) |
| Reach | A kthx Component's exposure: `none`, `private` or `public` | [Built apps](../apps/kthx/built-apps.md#addresses-and-config) |
| Registry | `nix/hosts/default.nix`, the list of every host, image and package | [NixOS](../platform/nixos.md#registry) |
| Root | An OpenTofu directory with its own state | [OpenTofu and Atlantis](../platform/opentofu.md) |
| Rowbutt | The chat bot that gives the owner a coding agent in Discord and Slack | [Rowbutt](../apps/mate.md) |
| Sandbox | The Kata microVM pod in which Rowbutt runs one thread | [Rowbutt](../apps/mate.md) |
| Site Magic | UniFi's WireGuard tunnel between the folly and offsite gateways | [Routing and firewall](../platform/network/routing-and-firewall.md) |
| Skiff | A Bosun microVM that runs one GitHub Actions job and then halts | [Bosun](../apps/bosun.md#terms) |
| Status | A page's state. `live` runs, `experiment` is a trial, `parked` is in the tree and runs nowhere, `unplugged` is powered off, `off-git` runs from config outside git, and `unverified` is unconfirmed. | [Style guide](style-guide.md#sections) |
| Tailnet | The owner's Tailscale network | [Remote access](../platform/network/remote-access.md) |
| Target | One runtime on a Vessel, where a kthx Component runs | [Built apps](../apps/kthx/built-apps.md#targets) |
| Token signer | The key that signs a cluster's ServiceAccount tokens | [PKI](../platform/pki.md#chain) |
| Tronbyt | The self-hosted Tidbyt server on folly | [Tidbyt apps](../apps/tidbyt.md) |
| trusted-builds | The GCP project that holds the kthx signing key and attestor | [Cloud accounts](../platform/cloud.md#google-cloud) |
| Turn | One prompt to Rowbutt and the agent's answer | [Rowbutt](../apps/mate.md) |
| Vessel | A cluster, GCP project, Vercel team or Cloudflare account that kthx deploys to | [Built apps](../apps/kthx/built-apps.md#concepts) |
| VIP | A load-balancer address from `LB_RANGE`, announced over BGP | [Routing and firewall](../platform/network/routing-and-firewall.md#routes) |
| Workload identity | GCP access from an OIDC token of a cluster, GitHub Actions or Vercel, with no stored key | [PKI](../platform/pki.md#workload-identity) |
| Zone | A group of UniFi networks that the gateway filters traffic between | [Routing and firewall](../platform/network/routing-and-firewall.md#firewall) |
