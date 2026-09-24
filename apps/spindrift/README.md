# kthx built apps

`apps/spindrift` is the engine behind kthx built apps. It connects a GitHub
repository, builds each app in it, deploys the build to a Target, and returns a
URL. See [Built apps](https://wiki.lolwtf.ca/apps/kthx/built-apps/).

One image runs two processes. `web` serves the console and the API behind it,
and `reconciler` runs the loops in `src/reconciler/`. Both need Postgres in
`DATABASE_URL`.

## Run

```bash
bun install                                  # once, at the repo root
export DATABASE_URL=postgres://postgres@127.0.0.1:15432/spindrift
bun run src/db/migrate.ts                    # apply src/db/migrations/
bun run dev                                  # the console, compiled on demand, on http://localhost:3000
bun run src/reconciler/main.ts               # the reconciler
```

An empty database starts with a placeholder installation manifest, and the
console opens on onboarding. `bun run build` writes the client to `dist/`, and
`bun run start` serves `dist/` as the image does.

## Test

```bash
bun run test         # against the Postgres in DATABASE_URL
bun run typecheck
bun run lint
```

`test/harness/db.ts` gives each test its own migrated schema. On WSL, a
container's published port does not reach the distro, so run Postgres natively:

```bash
nix shell nixpkgs#postgresql_16 -c bash -c '
  initdb -D /tmp/spg-data -U postgres --auth=trust &&
  pg_ctl -D /tmp/spg-data -l /tmp/spg-data/log -o "-p 15432 -c listen_addresses=127.0.0.1 -c fsync=off" start &&
  createdb -h 127.0.0.1 -p 15432 -U postgres spindrift'
```

The tests enforce these rules:

- A value that names an installation goes in the installation manifest
  (`src/config/manifest.schema.ts`). `test/extraction/no-literals.test.ts`
  fails on such a literal in `src/`.
- Each adapter passes `test/conformance/adapter-suite.ts`.
- A manifest schema change needs a step in `src/config/manifest-upgrade.ts`,
  and each document in `test/fixtures/stored-manifests/` must still load.
- Migrations are hand-written SQL in `src/db/migrations/`, listed in
  `meta/_journal.json`. The Drizzle snapshots stop at `0013`.

## Code map

| Directory | Holds |
| --- | --- |
| `src/web/` | The `web` process: the server, the command dispatch, and the React client in `client/` and `views/` |
| `src/commands/` | Each authenticated product action, as a command in `registry.ts` |
| `src/domain/` | Product rules and value types that no backend owns |
| `src/adapters/` | The build routes, deploy backends, datastores, DNS and secret stores. `registry.ts` wires them into an installation. |
| `src/reconciler/` | The `reconciler` process and its loops |
| `src/config/` | The installation manifest, its schema and its upgrades |
| `src/db/` | The Drizzle schema, the client and the migrations |
| `src/auth/` | Passkeys, sessions and the optional Gateway identity |
| `src/integrations/github/` | The GitHub App, the webhook and the configuration pull requests |
| `src/storage/` | Archive staging, the bosun build outbox and registry access |
| `src/supply-chain/` | Provenance verification and signing |
| `src/functions/` | Functions on Cloudflare Workers and Cloud Run |

## Deploy

`.github/workflows/containers.yml` publishes `ghcr.io/jonpulsifer/spindrift`.
`.github/workflows/spindrift-charts.yml` publishes the chart in
`packages/charts/spindrift/` to an OCI registry. Flux applies
`clusters/offsite/apps/spindrift/`, whose HelmRelease installs that chart. The
chart runs the migrations as a Job. The engine deploys each app on a Kubernetes
Target with the chart in `packages/charts/spindrift-app/`. The installation
manifest is a row in the database, and no file in git holds it. See
[Install kthx](https://wiki.lolwtf.ca/runbooks/install-kthx/).
