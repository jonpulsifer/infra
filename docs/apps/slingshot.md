---
title: Slingshot
description: A public web tool on Vercel that captures, inspects, diffs and replays HTTP webhooks, with one feed for each project.
status: live
---

Slingshot captures HTTP webhooks so the owner can inspect, diff and replay them. Each project has a short name, its slug. Every request to `/api/<slug>` goes into that project's feed. It is a Next.js app on Vercel, and it keeps the feeds in Firestore in the `homelab-ng` GCP project.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Web page | `https://slingshot.lolwtf.ca` | Anyone, with no sign-in |
| Webhook endpoint | `https://slingshot.lolwtf.ca/api/<slug>`, any HTTP method | Anyone |

Create a project on the web page, then send it a request. A request to an unknown slug returns 404.

```bash
curl -X POST https://slingshot.lolwtf.ca/api/my-project \
  -H 'Content-Type: application/json' -d '{"hello":"world"}'
```

The request shows in the project's feed within 2 seconds. The page also has a JWT decoder and a request-header inspector.

## Limits

- A project keeps its newest 100 webhooks.
- The endpoint accepts bodies up to 4.5 MB, the Vercel Functions limit. The app's own cap is 5 MB.
- The endpoint accepts 5 requests a second for each project. Each Vercel instance counts the rate on its own.
- Replay sends to a domain only if `WEBHOOK_ALLOWED_OUTGOING_DOMAINS` lists it, and it refuses private and link-local addresses. If the variable is empty, production refuses every destination.

## How it works

The browser polls the feed every 2 seconds and keeps a local copy. One Firestore transaction adds each webhook, removes the oldest past 100 and updates the counters.

The Vercel project `slingshot` reaches Firestore through Workload Identity Federation, with no service account key. Vercel's OIDC token for the project maps to a principal in the `homelab` pool, and that principal has `roles/datastore.user` in `homelab-ng`.

The Vercel project lives only in the Vercel dashboard, because no OpenTofu root uses the Vercel provider. The CNAME for `slingshot.lolwtf.ca` lives only in the Cloudflare dashboard, and `terraform/network/cloudflare/lolwtf.ca.tf` does not declare it. CI publishes the image `ghcr.io/jonpulsifer/slingshot`, and nothing runs it.

## Operate

No alerts watch Slingshot. `GET /api/healthz` returns 200.

## Reference

- Source: `apps/slingshot/`
- Firestore access: `terraform/gcp/projects/homelab-ng/slingshot.tf` and `terraform/gcp/projects/homelab-ng/datastore.tf`
- Vercel identity provider: `terraform/gcp/projects/homelab-ng/workload-identity.tf`
