---
title: Quick sites
description: A kthx quick site is a directory served at https://<name>.kthx.dev, with its own database, websocket, visitor ID, file store, model endpoint and MCP server.
status: live
---

A quick site is a directory that [kthx](../kthx.md) serves at `https://<name>.kthx.dev`. The owner and agents publish sites with the `kthx` command. One pod on [oldschool](../../hosts/oldschool.md), the offsite worker node, serves every site.

## Use it

[kthx](../kthx.md#use-it) lists the addresses. Publish from the lab, the offsite LAN or the tailnet owner's devices:

```bash
bun add -g https://kthx.dev/cli/kthx.tgz
export KTHX_ORIGIN=https://kthx.lolwtf.ca
kthx init my-site     # claims a random name; --name <name> picks one
kthx deploy my-site   # uploads a release and serves it
```

`kthx init` writes the name to `kthx.json` and its bearer token to `$XDG_CONFIG_HOME/kthx/sites.json`. A site claimed at [`kthx.<tailnet>`](../../hosts/index.md#reach-a-host) also has your tailnet login as its owner.

Every site answers these paths, and the SDK at `/api/sdk.js` wraps them as `window.kthx`. `https://kthx.dev/skill.md` has every path and quota.

| Path | What it is |
| --- | --- |
| `/api/db` | JSON documents with compare-and-swap |
| `/api/ws` | Websocket subscriptions and rooms |
| `/api/me` | A signed anonymous visitor ID |
| `/api/files`, `/files/*` | A file store. The visitor who creates a path owns it. |
| `/api/ai` | An OpenAI-compatible model on the lab's key |
| `/api/mcp` | The site as an MCP server, for its owner |

## Limits

- Anyone on a site's origin can write to its backends, within rate limits.
- You cannot rotate a bearer token or change a site's owner. If you lose the token of a site with no tailnet owner, you lose the site.
- The builder discards its sites' tokens, so only their owner's login can change them.
- A deleted name stays taken and answers `410`.

## How it works

Cloudflare sends `kthx.dev` and `*.kthx.dev` through the kthx Apps tunnel to the `spindrift-apps` Gateway ([kthx](../kthx.md#how-it-works)). The kthx server picks the site from the `Host` header. The `kthx` namespace's `app.kubernetes.io/part-of: spindrift` label lets its routes attach to that Gateway. Keep it.

An upload becomes a numbered release, stored as `releases/<sha256>.tar.gz` in the `bluenose-kthx` bucket and unpacked to a `local-path` volume. `kthx rollback` holds an older release until `kthx release`.

Each site has its own Postgres database and role on the `kthx-db` cluster. `KTHX_PG_KEY` derives each role's password, so a restore needs no stored passwords.

## Operate

| Alert | Meaning | Runbook |
| --- | --- | --- |
| `KthxServerDown` | No kthx pod has been available for 10 minutes, longer than a deploy | |
| `KthxDatabaseDown` | `kthx-db` is not reporting. Files still serve. | [Operate Postgres](../../runbooks/operate-postgres.md) |
| `KthxDatabaseVolumeFilling` | Site databases fill more than 80% of the `kthx-db` claim | [Operate Postgres](../../runbooks/operate-postgres.md) |
| `KthxSitesDiskFilling` | oldschool's `/mnt/disks` has less than 25% free | |
| `KthxBackupFailing` | `kthx-db-backup` has not succeeded in 36 hours | [Operate Postgres](../../runbooks/operate-postgres.md) |

A nightly `pg_dumpall` at 04:23 UTC writes to `backups/pg/` in the bucket, which keeps each dump 30 days. A restore loses later writes.

This tests production on a throwaway site and leaves its name taken.

```bash
KTHX_ORIGIN=https://kthx.lolwtf.ca scripts/kthx-verify.sh
```
