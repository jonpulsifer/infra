# Slingshot

Slingshot is a Next.js app that captures webhooks and lets you inspect, compare
and replay them. It stores them in Google Cloud Firestore. See
[Slingshot](https://wiki.lolwtf.ca/apps/slingshot/).

## Run and test

```bash
bun install          # once, at the repo root
bun run dev          # http://localhost:3000
bun test
bun run typecheck
bun run lint
```

In development, replay can reach any domain, but never a private or link-local
address. In production, `WEBHOOK_ALLOWED_OUTGOING_DOMAINS` (comma-separated,
`*.example.com` allowed) lists the replay targets, and without it production
refuses all of them.

## Code

| Path | Holds |
| --- | --- |
| `app/api/[slug]/` | Webhook capture |
| `app/[slug]/` | The project page |
| `lib/project-store.ts` | The storage interface. `lib/project-store-firestore.ts` implements it for production and `lib/project-store-memory.ts` for the tests. |
| `hooks/use-webhook-feed.ts` | The client feed: the localStorage cache, the 2-second poll and the selection |
| `lib/slug.ts` | The slug rules and the reserved names. Every caller uses it. |
| `lib/outgoing-webhook-sender.ts` | The SSRF checks on replay: the domain allowlist, and the resolved address of the request and of each redirect |

One Firestore transaction appends a webhook, removes the oldest past 100, and
updates the counters. `webhooksUpdatedAt` on a project is the feed etag, and a
client downloads the feed only when the etag changes.

## Deploy

Vercel runs the app as the project `slingshot`. On Vercel, it reaches Firestore
through workload identity federation, which
`terraform/gcp/projects/homelab-ng/slingshot.tf` and
`terraform/gcp/projects/homelab-ng/datastore.tf` grant. Elsewhere, it uses
Application Default Credentials. Without credentials, reads return empty
results, so a build still completes.

`.github/workflows/containers.yml` also publishes `ghcr.io/jonpulsifer/slingshot`.
No manifest in `clusters/` runs it.

## License

MIT
