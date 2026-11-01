# kthx

This package is kthx quick sites: `server/` answers `kthx.dev` and the
`/api/*` and `/files/*` of `<name>.kthx.dev`, and `cli/` is the `kthx` command
line. nginx serves a site's own files from the sites bucket. See
[Quick sites](https://wiki.lolwtf.ca/apps/kthx/sites/).

## Run

```bash
bun install                     # once, at the repo root
export DATABASE_URL=postgres://postgres@127.0.0.1:15432/kthx
export KTHX_ME_KEY=$(openssl rand -hex 32) KTHX_PG_KEY=$(openssl rand -hex 32)
export KTHX_SITES_BUCKET=sites STORAGE_EMULATOR_HOST=http://127.0.0.1:9023
bun run start                   # the server, on :8080
bun run cli/main.ts --help      # the command line, from this checkout
```

`server/env.ts` reads every variable, and the process fails at boot when a
required one is missing. `DATABASE_URL`, `KTHX_ME_KEY` and `KTHX_PG_KEY` are
required, and each key must be at least 32 bytes. `KTHX_SITES_BUCKET` names
the bucket of sites; the server reaches it with `GOOGLE_APPLICATION_CREDENTIALS`
or, for a local run, a JSON-API emulator at `STORAGE_EMULATOR_HOST`.
`KTHX_ID_AUDIENCES` lists the Google ID token audiences that open a site as its
owner. Without `KTHX_BUCKET`, `/api/files` objects stay under `TMPDIR`. `server/migrations/` holds the numbered SQL of the
control database, and the server applies it at boot.

## Code

- `server/index.ts` routes each request by its `Host` header: the apex, a site,
  one of the private hosts, or 404.
- `server/` also holds the per-site database, websocket, file store and visitor
  identity, and the `/api/ai` passthrough.
- `server/bucket.ts` is the sites bucket contract: the `<name>/.kthx` marker, the
  claim, and the sync `kthx deploy` runs. The CLI, the server and
  `scripts/move-sites.ts` share it.
- `cli/main.ts` is the command line, and `cli/adc.ts` reads the caller's
  Application Default Credentials. `cli/dev.ts` serves a directory on `:4321`
  and proxies `/api/*` and `/files/*` to the live site.
- `packages/kthx/` holds the SDK, the landing page and the agent reference that
  the apex serves. `packages/archive/` holds the bucket client.

## Test

```bash
bun test
bun run typecheck
bun run lint
```

The tests need a Postgres in `DATABASE_URL`. Each test builds its own schema
and drops it afterwards. The bucket is `@repo/archive/fake-gcs`, in memory.

## Build and deploy

`bun run pack` bundles the command line into `dist/kthx.tgz` with
`dist/version.json`. Do not use `bun pm pack`: it rewrites `workspace:*` to
`0.0.0`, and `bun add` then looks for the workspace packages on the public
registry. The image carries the tarball, and the apex serves it at
`/cli/kthx.tgz`.

`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/kthx`. Flux
applies `clusters/offsite/apps/kthx/`, which installs `packages/charts/kthx`.
The zone is `terraform/network/cloudflare/kthx.dev.tf`.
