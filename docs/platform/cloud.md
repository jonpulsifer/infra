---
title: Cloud accounts
description: The Google Cloud projects, Cloudflare zones and Google Workspace domain that OpenTofu declares, and what each one is for.
---

The lab has three cloud accounts: a Google Cloud organization, a Cloudflare account and a Google Workspace domain. kthx, public DNS and cluster workload identity depend on them. [OpenTofu](opentofu.md) declares all three, and Atlantis applies them from pull requests.

## Google Cloud

The organization root declares folders, projects, budgets, policies, custom roles and IAM. The Google providers of most roots impersonate the `terraform` service account in `homelab-ng`.

| Project | What it is for |
| --- | --- |
| `homelab-ng` | It has the OpenTofu state bucket, Firestore and the [oldboy](../hosts/oldboy.md) VM. It also has the KMS key that unseals [OpenBao](secrets.md#openbao), the Prowler cloud-scanner identity, and workload identity pools for GitHub Actions, Vercel and the clusters. |
| `bluenose` | It has the storage, identities and Secret Manager of [kthx](../apps/kthx.md). It is also the default Vessel, the project that kthx deploys [Apps](../apps/kthx/built-apps.md) into. |
| `trusted-builds` | The supply chain of kthx Apps. It has the signing key, the Binary Authorization attestor, a staging registry and the Developer Connect link to GitHub. |
| `lolcorp` | An audit-log pipeline that scores logs with Gemini and writes anomalies to BigQuery. Its feed, the organization sink `audit-log-sink`, is off. |
| `wishin-app` | The Firebase project of wishin.app, a gift wishlist site. |
| `jonpulsifer` | The owner's `jonpulsifer` bucket and a `dotfiles` Cloud Source repository. |

`projects.tf` also declares `firebees`, `kubesec`, `secure-the-cloud` and `cloud-glue`, which no documented app uses.

## Cloudflare

The Cloudflare root declares the zones, the Cloudflare Tunnels that [Ingress and DNS](network/ingress-and-dns.md) describes, and the Pages projects of `wiki.lolwtf.ca` and `oidc.lolwtf.ca`.

| Zone | What it is for |
| --- | --- |
| `lolwtf.ca` | Lab hosts, cluster services and API servers, the wiki, and the cluster OIDC documents |
| `lolwtf.dev` | The default zone for App names (`SPINDRIFT_DOMAIN`) |
| `kthx.dev` | [kthx](../apps/kthx.md) at the apex, and its quick sites at `<name>.kthx.dev` |
| `clankerbanker.ca` | [clankerbanker](../apps/clankerbanker.md) |
| `embarrassing.ca` | App names |
| `pulsifer.ca` | [pulsifer.ca](../apps/pulsifer-ca.md) on GitHub Pages, and mail on Google Workspace |
| `wishin.app` | wishin.app on Vercel, and App names |

## Google Workspace

The Workspace root declares the `pulsifer.ca` domain, its alias `pulsifer.dev`, the owner's user, a `terraform` user and an `agent` user. Its `cloud@pulsifer.ca` group holds Owner and the organization admin roles in Google Cloud. The group's members include the `agent` user and the `terraform` service account.

## Rules

- Create a project in `terraform/gcp/organization/projects.tf`, or it has no folder, billing account or deletion lien. Then give it a root.
- The organization blocks new service account keys. Give a workload a federated identity.
- Keep a new App zone in step with the external-dns and cert-manager lists in [Ingress and DNS](network/ingress-and-dns.md), or its names do not resolve.
- Turn on `audit-log-sink` only after the `lolcorp` pipeline has a pre-LLM filter or daily budget, and keep its `token-plumbing` exclusion. Each exported event costs a Gemini call.

## Where it lives

- `terraform/gcp/organization/`: the organization
- `terraform/gcp/projects/<project>/`: the project roots
- `terraform/network/cloudflare/`: the Cloudflare account
- `terraform/google-workspace/`: Google Workspace

## Related

- [OpenTofu and Atlantis](opentofu.md)
- [PKI](pki.md)
