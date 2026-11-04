---
title: Quick sites
description: A kthx quick site is a directory served at https://<name>.kthx.dev from a bucket, with its own database, websocket, visitor ID, file store, model endpoint and MCP server.
status: live
---

A quick site is a directory that [kthx](../kthx.md) serves at `https://<name>.kthx.dev`, from the folder `<name>/` in the `bluenose-kthx-sites` bucket. The owner and agents deploy sites with the `kthx` command.

## Use it

Deploy with Application Default Credentials that may write the bucket:

```bash
bun add -g https://kthx.dev/cli/kthx.tgz
gcloud auth application-default login
kthx init my-site     # claims a random name; --name <name> picks one
kthx deploy my-site   # syncs the directory to the site's folder
```

`kthx init` claims the name with a marker, `<name>/.kthx`, that names the credentials' email as the owner. Deploying over someone else's site asks first, and with no terminal needs `--force`. `kthx rm` frees the name.

The SDK at `/api/sdk.js` wraps these paths as `window.kthx`, and `https://kthx.dev/skill.md` has every quota.

| Path | What it is |
| --- | --- |
| `/api/db` | JSON documents with compare-and-swap |
| `/api/ws` | Websocket subscriptions and rooms |
| `/api/me` | A signed anonymous visitor ID |
| `/api/files`, `/files/*` | A file store. The visitor who creates a path owns it. |
| `/api/ai` | An OpenAI-compatible model on the lab's key |
| `/api/mcp` | The site as an MCP server, for its owner |

## Limits

- Ownership is a courtesy: anyone who may write the bucket may change any site.
- A deploy shows within about 10 seconds, the bucket mount's cache time.
- A deploy is not atomic. HTML goes last, but a visitor can see a mix while it runs.
- There is no rollback. The bucket keeps three noncurrent versions of each object for 30 days: [Restore a site](../../runbooks/restore-a-site.md).
- Anyone on a site's origin can write to its backends, within rate limits.
- A name the engine reserves for a built app reads as taken.

## How it works

Cloudflare sends `*.kthx.dev` through the kthx Apps tunnel to the `kthx-apps` Gateway ([kthx](../kthx.md#how-it-works)). nginx in the `kthx-sites` namespace serves each site from a read-only gcsfuse mount of the bucket, and sends `/api/*` and `/files/*` to the kthx server.

`kthx deploy` uploads the files whose CRC-32C differs, deletes the rest, and rewrites the marker only if its generation is the one it read, so a racing deploy fails.

Owner calls take a Google ID token whose email the marker names, with an audience in `KTHX_ID_AUDIENCES`, or the tailnet login on [`kthx.<tailnet>`](../../hosts/index.md#reach-a-host).

A site gets its Postgres database and role on `kthx-db` at its first `/api/db` or `/api/ws` call. `KTHX_PG_KEY` derives each password. The server drops a site's database and files when its marker is gone.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `KthxServerDown` | No kthx pod has been available for 10 minutes, longer than a deploy | |
| `KthxDatabaseDown` | `kthx-db` is not reporting. Pages still serve. | [Operate Postgres](../../runbooks/operate-postgres.md) |
| `KthxDatabaseVolumeFilling` | Site databases fill more than 80% of the `kthx-db` claim | [Operate Postgres](../../runbooks/operate-postgres.md) |
| `KthxBackupFailing` | `kthx-db-backup` has not succeeded in 36 hours | [Operate Postgres](../../runbooks/operate-postgres.md) |

A nightly `pg_dumpall` at 04:23 UTC writes to `backups/pg/` in the `bluenose-kthx` bucket, which keeps each dump 30 days. CloudNativePG archives `kthx-db` to offsite's Garage.

This tests production on a throwaway site:

```bash
scripts/kthx-verify.sh
```

`apps/kthx/scripts/move-sites.ts` copies each site's serving release from `releases/` in `bluenose-kthx` into the bucket, and writes only with `--apply`.
