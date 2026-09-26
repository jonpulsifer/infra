---
name: publish-on-kthx
description: >-
  Put a directory on the internet as a kthx quick site with the kthx CLI, or
  drive kthx built apps through the kthx MCP tools. Use when asked to publish,
  list, roll back or delete a site on kthx.dev, or to build and deploy an app
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

In a Rowbutt sandbox, `KTHX_ORIGIN` is preset and `kthx` is on `PATH`. Bearers
persist across sandboxes: mate keeps `$XDG_CONFIG_HOME/kthx/sites.json` in
Secret `mate-kthx-sites` and stamps it in at the start of each turn, so
`kthx ls` lists every site Rowbutt has claimed.

```bash
kthx init --name <name> <dir>   # claims the name; writes <dir>/kthx.json
kthx deploy <dir>               # uploads a release and serves it
kthx ls                         # every site of yours; in a site's dir, its releases
kthx rollback                   # serves the previous release and holds it
printf '%s\n' <name> | kthx rm  # deletes the site; the name stays taken
```

- `kthx rm` asks for the site's name on stdin and deletes nothing without it.
  A bare `kthx rm` in a sandbox, which has no terminal, exits 0 and keeps the
  site.
- Run `kthx init` first, or run `kthx deploy` from inside the directory.
  `kthx deploy` on a directory with no `kthx.json` writes one to the current
  directory, not the target.
- Never run `kthx upgrade` in a sandbox. The image bakes the CLI, and upgrade
  installs a second copy the sandbox's `kthx` never runs.
- Never commit a site's `kthx.json` or `SKILL.md` into this repository unless
  the site's source lives here.
- A lost bearer is a lost site. Do not edit `sites.json` by hand.

From a human's shell the same commands work on the lab, the offsite LAN or the
tailnet with `KTHX_ORIGIN=https://kthx.lolwtf.ca`.

## Built apps

When the sandbox has an agent token, opencode has a `kthx` MCP server and its
tools are the console's commands. `docs/runbooks/connect-an-agent-to-kthx.md`
says what a token can and cannot do, and `docs/apps/kthx/security.md` lists
the identities. No `kthx` tools in the session means the token is absent,
expired or revoked; say so rather than retry.
