---
name: publish-on-kthx
description: >-
  Put a directory on the internet as a kthx quick site with the kthx CLI, or
  drive kthx built apps through the kthx MCP tools. Use when asked to publish,
  list, restore or delete a site on kthx.dev, or to build and deploy an app
  through kthx.
metadata:
  wiki: https://wiki.lolwtf.ca/apps/kthx/sites/
---

# Publish on kthx

kthx is the lab's hosting product, `docs/apps/kthx.md`. It has two kinds of
app: a quick site, a directory served at `https://<name>.kthx.dev`
(`docs/apps/kthx/sites.md`), and a built app, a repository built and deployed
to a cluster or a cloud (`docs/apps/kthx/built-apps.md`). `packages/kthx/skill.md`
is the API reference a quick site's own code uses: `window.kthx`, `/api/db`,
`/api/ws`, `/api/files`, `/api/ai` and `/api/mcp`.

## Quick sites

A site is the folder `<name>/` in the `bluenose-kthx-sites` bucket, and the CLI
writes it with the caller's Google Application Default Credentials. Their
email owns the site. On the owner's workstation that is
`gcloud auth application-default login`. A Rowbutt sandbox needs an
`external_account` file for the `kthx-deployer` service account in
`GOOGLE_APPLICATION_CREDENTIALS`, and its sites are owned by that account.

```bash
kthx init --name <name> <dir>   # claims the name; writes <dir>/kthx.json
kthx deploy <dir>               # syncs the directory: changed files, HTML last
kthx ls                         # every site of yours; in a site's dir, its owner
printf '%s\n' <name> | kthx rm  # deletes the site and frees the name
```

- A site someone else owns: `kthx deploy` and `kthx rm` ask first, and with no
  terminal they refuse with `NOT_YOURS`. Pass `--force` only when the owner
  asked for the change. Ownership is a courtesy, not a lock.
- `kthx deploy` syncs the entire directory and deletes remote files absent from
  it. To edit an existing site, start from its complete source, including its
  `SKILL.md` if it serves one. Compare the files before deploying; a downloaded
  page alone is not the site's source. If a partial deploy removes a file, use
  `docs/runbooks/restore-a-site.md` to recover its prior object version.
- `RACED` means another deploy rewrote the site while yours ran. Compare its
  current files with your source before deploying again.
- There is no rollback. `docs/runbooks/restore-a-site.md` copies files back
  from the bucket's noncurrent versions, for 30 days.
- A deploy shows within about 10 seconds, and is not atomic.
- `kthx rm` asks for the site's name on stdin and deletes nothing without it.
- Run `kthx init` first, or run `kthx deploy` from inside the directory.
  `kthx deploy` on a directory with no `kthx.json` writes one to the current
  directory, not the target.
- Never run `kthx upgrade` in a sandbox. The image bakes the CLI, and upgrade
  installs a second copy the sandbox's `kthx` never runs.
- Never commit a site's `kthx.json` or `SKILL.md` into this repository unless
  the site's source lives here.

## Built apps

The kthx MCP server has one tool per console command. Rowbutt gets them as
`kthx_*` tools when mate holds an agent token. pi on the owner's workstation
gets them as `mcp__kthx__*` tools from the `mate` pi package, with the owner's
workstation token and never the bot's; load them with `tool_search`.
`docs/runbooks/connect-an-agent-to-kthx.md` says what a token can and cannot
do, and `docs/apps/kthx/security.md` lists the identities. No kthx tools in
the session means no token, an expired or revoked token, or, for Rowbutt, that
mate has not reached the engine since it started; mate retries every minute.
Say which is likely rather than retry, and do not assume the token is bad.
