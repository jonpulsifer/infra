# kthx

[kthx.dev](https://kthx.dev): a directory becomes `https://<name>.kthx.dev`.
This package is both halves — `server/` is the process that answers the zone,
`cli/` is the command line that talks to it.

## The server

One Bun process on `:8080`, behind the Cilium Gateway. It dispatches on `Host`:
`kthx.dev` is the apex, `<name>.kthx.dev` is a site, anything else is 404.

| Surface | What it is |
| --- | --- |
| `POST /api/sites` | claim a name for the Google account on the request |
| `/api/sites/:name…` | inspect, upload a release, `serve` one, drop the `hold`, `adopt`, delete |
| `GET /api/whoami` | the address the server read out of the token it verified |
| apex `/`, `/sdk.js`, `/skill.md`, `/favicon.ico` | the files `@repo/kthx` carries |
| apex `/cli/kthx.tgz` | the command line, packed into the image by `pack.ts` |
| `<name>.kthx.dev/*` | the release the site's row says it serves |
| `<name>.kthx.dev/api/*` | the site's own backends — `me`, `db`, `ws`, `files` |
| `<name>.kthx.dev/files/*` | the site's file store, served with its stored type |

A release is read once (`@repo/archive`: a ZIP is transcoded to the gzipped tar
everything downstream opens), stored in the depot under its own sha256, unpacked
to `$KTHX_SITES_DIR/<name>/<n>/`, and numbered under the site row's lock. The
directory is a cache of the depot object: a release whose directory is gone is
refilled from its `location`, so losing the volume costs latency and never data.

Files are the same deal one level over: `$KTHX_SITES_DIR/<name>/files/<path>`,
never inside a release, written through to `files/<name>/<path>` in the depot
and refilled from it. Anyone on the site origin may `PUT` one; the visitor who
created a path owns it, and the content-type allowlist is what keeps a public
store from becoming a page on the site's own origin.

`/api/ai` is an OpenAI-compatible passthrough on the operator's key: three
upstream paths by name, the client's `Authorization` dropped, and a per-site
daily budget in the control database that a restart cannot reset. Without
`KTHX_AI_KEY` it answers 502 and nothing else changes.

An owner is a Google account. `server/identity.ts` verifies the ID token the
CLI sends — RS256 over `crypto.subtle` against Google's JWKS, then the issuer,
the audience, the expiry and `email_verified` — and the site row keeps the
account's `sub` beside the address it displays. `KTHX_TRUSTED_IDENTITY_HEADER`
is the seam for an IAP-style proxy front: name a header and a request from a
peer in `KTHX_TRUSTED_PROXIES` carrying it *is* that identity, no token. It is
unset, so today nothing but a verified token is believed. A site claimed before
accounts keeps its bearer until `POST /api/sites/:name/adopt` trades it for one.

Configuration: `KTHX_ZONE`, `KTHX_BUCKET` (unset uses an on-disk depot),
`KTHX_SITES_DIR`, `DATABASE_URL`, `KTHX_ME_KEY` (+ optional
`KTHX_ME_KEY_PREVIOUS`) and `KTHX_PG_KEY`, both at least 32 bytes,
`KTHX_TRUSTED_PROXIES` — the comma-separated peers whose `cf-connecting-ip` the
rate limits believe — and the AI upstream's `KTHX_AI_URL`, `KTHX_AI_KEY`,
`KTHX_AI_MODEL`, `KTHX_AI_MODELS` (a comma list; empty is every model the
upstream sells) and `KTHX_AI_MAX_TOKENS`; `KTHX_OIDC_AUDIENCES` (the `aud` an ID
token may carry, defaulting to gcloud's own client id) and
`KTHX_TRUSTED_IDENTITY_HEADER`. With `KTHX_TRUSTED_PROXIES` unset, no
peer is believed and every address-keyed bucket keys on the socket address,
which behind a proxy is one key for the whole zone. The control database's
schema is the numbered SQL in `server/migrations/`, applied at boot.

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
| `kthx whoami` | the Google account this machine claims sites as |
| `kthx adopt` | takes a site claimed before accounts, with its stored bearer |
| `kthx upgrade` | re-runs `bun add -g` on the apex tarball |

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

`dist/version.json` is packed with the bundle and copied beside the tarball in
the image, so `x-kthx-build` on `/cli/kthx.tgz` and an installed copy's own
`--version` read the same bytes. Its build id is the first twelve hex of the
bundle's sha256 rather than a git sha, which is not available where `pack` runs:
the Dockerfile packs from a `turbo prune` tree, which has no `.git`. The content
hash is also the identity the update check wants — it changes exactly when the
command line does.

Every command but `upgrade` and `--version` asks once a day whether the apex has
a different build: one `HEAD /cli/kthx.tgz` capped at 1.5 s, started beside the
command and remembered in `$XDG_CONFIG_HOME/kthx/update.json`. It prints one
line and can do nothing else — it never fails a command, delays it past the cap,
or changes an exit code — and it is skipped outright over a pipe, with
`KTHX_NO_UPDATE_CHECK=1`, and in a checkout, which has no build of its own.

`cli/paint.ts` is the only file that knows an escape code. Colour is off when
stdout is not a TTY, `NO_COLOR` is set, or `TERM=dumb`, and drops from truecolor
to the 256-colour cube without `COLORTERM`.

`kthx dev` does not simulate the backends. It proxies `/api/*` (the websocket
included) and `/files/*` to `https://<name>.kthx.dev`, rewriting `Origin` to the
site's and the visitor cookie to a plain `kthx_me` a browser will keep over
`http://localhost`. The owner's token is attached to the two owner-scoped routes
and to nothing else, so the loop is rate-limited exactly as a visitor is. The
data is the site's own, live.

`KTHX_ORIGIN` points the client somewhere other than `https://kthx.dev`. What
opens a site is the Google account: `cli/identity.ts` shells out to `gcloud auth
print-identity-token` once and keeps the token until its `exp`, and
`KTHX_IDENTITY_TOKEN` replaces the shell-out where there is no gcloud.
`$XDG_CONFIG_HOME/kthx/sites.json` (0600) still holds the bearers of sites
claimed before accounts; `kthx adopt` is the only command that reads one, and it
forgets the string once the apex has taken it.

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
