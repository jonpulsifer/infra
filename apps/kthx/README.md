# kthx

This package is kthx quick sites: `server/` answers `kthx.dev` and
`<name>.kthx.dev`, and `cli/` is the `kthx` command line. See
[Quick sites](https://wiki.lolwtf.ca/apps/kthx/sites/).

## Run

```bash
bun install                     # once, at the repo root
export DATABASE_URL=postgres://postgres@127.0.0.1:15432/kthx
export KTHX_ME_KEY=$(openssl rand -hex 32) KTHX_PG_KEY=$(openssl rand -hex 32)
export KTHX_SITES_DIR=/tmp/kthx-sites
bun run start                   # the server, on :8080
bun run cli/main.ts --help      # the command line, from this checkout
```

`server/env.ts` reads every variable, and the process fails at boot when a
required one is missing. `DATABASE_URL`, `KTHX_ME_KEY` and `KTHX_PG_KEY` are
required, and each key must be at least 32 bytes. Without `KTHX_BUCKET`, the
depot is on the local disk. `server/migrations/` holds the numbered SQL of the
control database, and the server applies it at boot.

## Code

- `server/index.ts` routes each request by its `Host` header: the apex, a site,
  one of the private hosts, or 404.
- `server/` also holds the per-site database, websocket, file store and visitor
  identity, and the `/api/ai` passthrough.
- `cli/main.ts` is the command line. `cli/dev.ts` serves a directory on `:4321`
  and proxies `/api/*` and `/files/*` to the live site.
- `packages/kthx/` holds the SDK, the landing page and the agent reference that
  the apex serves. `packages/archive/` reads uploaded archives.

## Test

```bash
bun test
bun run typecheck
bun run lint
```

The tests need a Postgres in `DATABASE_URL`. Each test builds its own schema
and drops it afterwards.

## Build and deploy

`bun run pack` bundles the command line into `dist/kthx.tgz` with
`dist/version.json`. Do not use `bun pm pack`: it rewrites `workspace:*` to
`0.0.0`, and `bun add` then looks for the workspace packages on the public
registry. The image carries the tarball, and the apex serves it at
`/cli/kthx.tgz`.

`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/kthx`. Flux
applies `clusters/offsite/apps/kthx/`, which installs `packages/charts/kthx`.
The zone is `terraform/network/cloudflare/kthx.dev.tf`.
