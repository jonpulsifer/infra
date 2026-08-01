# Slingshot — Webhook Testing Platform

Capture, inspect, diff, and replay webhooks. Next.js 16 App Router over Google
Cloud Firestore.

## Features

- **Capture** — every HTTP method, headers, body, IP, and user agent
- **Live feed** — etag-based freshness polling with a local-first cache
- **Inspect** — headers, body, response, and raw payload with syntax highlighting
- **Diff** — inline and side-by-side comparison of any two events
- **Replay safely** — server-side SSRF protection: domain allowlist plus
  resolved-IP validation on the initial request and every redirect hop
- **Rate limiting** — 5 req/sec per project
- **Circular buffer** — the newest 100 webhooks per project

## Architecture

### Storage

One module owns persistence: `lib/project-store.ts` declares the interface, and
two adapters satisfy it — `lib/project-store-firestore.ts` in production and
`lib/project-store-memory.ts` in the tests.

Document model:

```
slingshot/{slug}              project, counters, and version markers
slingshot/{slug}/webhooks/*   the circular buffer
slingshot/_meta               global counters
```

Appending a webhook, evicting past the cap, and updating the counters happen in
a single transaction, so `webhookCount` always matches the number of documents
retained and `_meta.totalWebhooks` stays equal to the sum of the per-project
counts.

### Freshness

`webhooksUpdatedAt` on the project document is the feed etag; `_meta.updatedAt`
is the stats etag. Both are millisecond timestamps stamped on every write.
Clients poll `pollFeedAction` with the etag they hold and get data back only
when it has moved. This is staleness detection, not locking — a client cannot
use an etag to prevent a write, only to skip a download.

### Feed state

`hooks/use-webhook-feed.ts` owns the client-side feed: the localStorage cache,
the 2-second poll, and the selection. Components render what it returns.

### Slugs

`lib/slug.ts` owns both the shape rules and the reserved names. The ingest
route, the project page, the create form, and the nav all ask it — there is no
second list.

### Outgoing requests

`lib/request-draft.ts` holds the pure conversions between key/value fields and
raw JSON, and resolves a draft into the request that gets sent.
`sendOutgoingWebhookAction` is the only path that sends one, and it goes through
`lib/outgoing-webhook-sender.ts` for the SSRF checks.

### Authentication

Workload Identity Federation on Vercel; Application Default Credentials
elsewhere. Reads degrade to empty results when credentials are unavailable so a
build without them still completes.

## Layout

```
apps/slingshot/
├── app/
│   ├── api/[slug]/         webhook ingestion
│   ├── api/healthz/        health check
│   ├── [slug]/             project page
│   ├── cache/              local cache inspector
│   ├── environment/        environment variables
│   ├── gcp/                Firestore collections
│   ├── jwt-decoder/        JWT decoder
│   └── request-headers/    request header inspector
├── components/
├── hooks/
└── lib/
```

## Development

```bash
bun install
bun run dev        # http://localhost:3000
bun test           # unit tests
bun run typecheck
bun run lint
```

Set `WEBHOOK_ALLOWED_OUTGOING_DOMAINS` (comma-separated, `*.example.com`
supported) to permit replay targets in production. Without it, production
refuses every outgoing destination. In development all domains are allowed,
though private and link-local addresses are still refused.

## Usage

Create a project, then send anything to `POST /api/{slug}`:

```bash
curl -X POST https://<host>/api/my-project \
  -H 'Content-Type: application/json' \
  -d '{"hello":"world"}'
```

The request appears in the feed within a couple of seconds.

## Limitations

- The rate limiter is in-memory and per-instance, not distributed.
- The feed polls on a 2-second interval rather than streaming.
- Only the newest 100 webhooks per project are retained.

Acceptable for a debugging tool; not intended as a production webhook consumer.

## License

MIT
