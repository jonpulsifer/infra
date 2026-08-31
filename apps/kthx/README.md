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
| apex `/cli/kthx.tgz` | the command line, packed into the image by `pack.ts` |
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
| `kthx init [dir] [--name <n>]` | claims a name; writes `kthx.json`, a `SKILL.md` fetched from the apex, and a starter page into an empty directory |
| `kthx deploy [dir] [--name <n>]` | uploads the directory as a release |
| `kthx dev [dir]` | serves the directory on `:4321` with production's resolution rules, and hands `/api/*` and `/files/*` to the site itself |
| `kthx rollback [n]` | serves release `n` (default: the one before) and holds it |
| `kthx release` | drops the hold; the newest release serves |
| `kthx ls` | what the site serves, and what it uses against its quotas |
| `kthx rm` | deletes the site, once its name is typed back |
| `kthx open` | opens the site |

```
bun add -g https://kthx.dev/cli/kthx.tgz
```

`bun run pack` builds that tarball into `dist/`: `cli/main.ts` bundled to one
file — `@repo/kthx`'s agent reference and favicon inlined with it — beside
a manifest with no dependencies. Packing this workspace directly cannot work:
`bun pm pack` rewrites `workspace:*` to `0.0.0`, and `bun add` then looks for
`@repo/archive@0.0.0` on the public registry. The image carries the tarball and
the apex serves it at `/cli/kthx.tgz`, so the command line always matches the
server it talks to.

`kthx dev` does not simulate the backends. It proxies `/api/*` (the websocket
included) and `/files/*` to `https://<name>.kthx.dev`, rewriting `Origin` to the
site's and the visitor cookie to a plain `kthx_me` a browser will keep over
`http://localhost`. The owner bearer is attached to the two owner-scoped routes
and to nothing else, so the loop is rate-limited exactly as a visitor is. The
data is the site's own, live.

`KTHX_ORIGIN` points the client somewhere other than `https://kthx.dev`. The
token that opens a site is in `$XDG_CONFIG_HOME/kthx/sites.json` (0600), by
origin and name — never in the directory, which is what gets uploaded. There is
no account and no reset: a lost token is a lost site.

The name is `kthx.json`, read from the directory and then from the current one,
so `kthx deploy dist` inside a project root deploys the project's site. `init`
writes it into the directory it is given; `deploy` and `dev` write it where they
run, so a build output directory that is rebuilt from scratch does not take the
name with it.

An upload is a gzipped ustar of the directory without dotfiles, `node_modules`,
and `kthx.json`; symlinked files are carried as files. Like a release, `kthx dev`
treats a lone top-level directory as the site.

## Tests

`bun test` needs a Postgres to build a schema in — `DATABASE_URL` names it, and
each test gets its own schema, dropped afterwards.
