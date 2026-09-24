---
title: kthx
description: The lab's hosting product on the offsite cluster, which the owner and agents use to serve a directory at <name>.kthx.dev or to build a repository and deploy it to a cluster or a cloud.
status: live
---

kthx is the lab's hosting product. The owner and agents use it to put apps on the internet or on the lab network. Its quick-site server and built-app engine run on the offsite [Kubernetes](../platform/kubernetes.md) cluster, and each built app runs on its Target. It has two kinds of app.

| Kind | You give it | You get |
| --- | --- | --- |
| [Quick site](kthx/sites.md) | A directory, a zip or an `index.html` | `https://<name>.kthx.dev`, with a database, a websocket, a visitor ID and a file store |
| [Built app](kthx/built-apps.md) | A GitHub repository or an uploaded archive | A signed build, deployed to a cluster, Cloud Run, Firebase Hosting, Vercel or Cloudflare Pages |

[Ownership and security](kthx/security.md) says which system owns each part and what it can reach.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Quick sites | `https://<name>.kthx.dev` | Anyone |
| Landing page, site directory, SDK, agent reference and CLI | `https://kthx.dev` | Anyone |
| Quick-site claims, uploads and deletes | `https://kthx.lolwtf.ca` | The lab, the offsite LAN and the tailnet owner |
| Quick-site builder and tailnet-login claims | [`https://kthx.<tailnet>`](../hosts/index.md#reach-a-host) | Every tailnet member |
| Console for built apps | `https://spindrift.lolwtf.ca` | The lab, the offsite LAN and the tailnet owner, with a passkey |
| MCP endpoint for built apps | `https://spindrift-control.lolwtf.dev/mcp` | The internet, with an agent token |

## How it works

One Bun process in the `kthx` namespace serves quick sites. The kthx engine in the `spindrift` namespace builds and deploys built apps. The engine is a `web` process for the console, API and MCP, a `reconciler` that builds and deploys, and their CloudNativePG database.

Quick sites and the engine share the Cloudflare tunnel named `spindrift`, called the kthx Apps tunnel, and the `spindrift-apps` Gateway on offsite. They also share the archive reader in `packages/archive/` and the bluenose GCP project, and each has its own database and bucket.

Flux deploys quick sites from `packages/charts/kthx/` in git. It deploys the engine, and the engine its Apps, from the OCI charts that `.github/workflows/spindrift-charts.yml` publishes. [Build and release](../platform/build-and-release.md#rules) has the rule for a chart change.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `SpindriftDeployFailed` | A deploy ended FAILED. The console's Deploys page shows the reason. | |
| `SpindriftDeployLost` | A reconciler stopped during a deploy. Read its pod's logs. | |

[Quick sites](kthx/sites.md#operate) lists its alerts. [Install kthx](../runbooks/install-kthx.md) installs the engine, and [Connect an agent to kthx](../runbooks/connect-an-agent-to-kthx.md) gives an agent the MCP endpoint. [Operate Postgres](../runbooks/operate-postgres.md) covers both databases.

## Reference

- Quick sites: `apps/kthx/`, `packages/kthx/`, `packages/charts/kthx/` and `clusters/offsite/apps/kthx/`. Image `ghcr.io/jonpulsifer/kthx`.
- Built apps: `apps/spindrift/`, `packages/charts/spindrift/`, `packages/charts/spindrift-app/`, `clusters/offsite/apps/spindrift/` and `clusters/base/platform/spindrift-target/`. Image `ghcr.io/jonpulsifer/spindrift`.
- Cloud: `terraform/network/cloudflare/kthx.dev.tf`, `terraform/network/cloudflare/spindrift.tf` and `terraform/gcp/projects/bluenose/`
