# kthx

[kthx.dev](https://kthx.dev): a directory becomes `https://<name>.kthx.dev`.
This package is both halves — `server/` is the process that answers the zone,
`cli/` is the command line that talks to it.

## The server

One Bun process on `:8080`, behind the Cilium Gateway. It dispatches on `Host`:
`kthx.dev` is the apex, `<name>.kthx.dev` is a site, anything else is 404.

| Surface | What it is |
| --- | --- |
| `POST /api/sites` | claim a name; the bearer is minted once and shown once |
| `/api/sites/:name…` | inspect, upload a release, `serve` one, drop the `hold`, delete |
| apex `/`, `/sdk.js`, `/skill.md`, `/favicon.ico` | the files `@repo/kthx` carries |
| `<name>.kthx.dev/*` | the release the site's row says it serves |

A release is read once (`@repo/archive`: a ZIP is transcoded to the gzipped tar
everything downstream opens), stored in the depot under its own sha256, unpacked
to `$KTHX_SITES_DIR/<name>/<n>/`, and numbered under the site row's lock. The
directory is a cache of the depot object: a release whose directory is gone is
refilled from its `location`, so losing the volume costs latency and never data.

Configuration: `KTHX_ZONE`, `KTHX_BUCKET` (unset uses an on-disk depot),
`KTHX_SITES_DIR`, `DATABASE_URL`, `KTHX_ME_KEY` (+ optional
`KTHX_ME_KEY_PREVIOUS`) and `KTHX_PG_KEY`, both at least 32 bytes, and
`KTHX_TRUSTED_PROXIES` — the comma-separated peers whose `cf-connecting-ip` the
rate limits believe. Unset, no peer is believed and every address-keyed bucket
keys on the socket address, which behind a proxy is one key for the whole zone.
The control database's schema is the numbered SQL in `server/migrations/`,
applied at boot.

```
bun run apps/kthx/server      # or `bun run start` from this directory
```

## The command line

| Command | What it does |
| --- | --- |
| `kthx deploy [dir] [--name <n>]` | uploads the directory; mints a name and writes `<dir>/kthx.json` when none is set |
| `kthx dev [dir]` | serves the directory on `:4321` with production's resolution rules |
| `kthx rollback [n]` | serves release `n` (default: the one before) and holds it |
| `kthx release` | drops the hold; the newest release serves |

`KTHX_ORIGIN` points the client somewhere other than `https://kthx.dev`. The
token that opens a site is in `$XDG_CONFIG_HOME/kthx/sites.json` (0600), by
origin and name — never in the directory, which is what gets uploaded. There is
no account and no reset: a lost token is a lost site.

The package is not published. From a checkout, `bunx --bun kthx` at the repo
root runs it (the root `package.json` links the workspace bin), and
`bun apps/kthx/cli/main.ts` runs it from anywhere.

An upload is a gzipped ustar of the directory without dotfiles, `node_modules`,
and `kthx.json`; symlinked files are carried as files. Like a release, `kthx dev`
treats a lone top-level directory as the site.

## Tests

`bun test` needs a Postgres to build a schema in — `DATABASE_URL` names it, and
each test gets its own schema, dropped afterwards.
