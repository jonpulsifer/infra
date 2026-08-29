# kthx

The command line for [kthx.dev](https://kthx.dev): a directory becomes
`https://<name>.kthx.dev`.

| Command | What it does |
| --- | --- |
| `kthx deploy [dir] [--name <n>]` | uploads the directory; mints a name and writes `<dir>/kthx.json` when none is set |
| `kthx dev [dir]` | serves the directory on `:4321` with production's resolution rules and an in-process `/_/` (db, me, ws) fronting the real `sdk.js` |
| `kthx rollback [n]` | serves release `n` (default: the one before) and holds it |
| `kthx release` | drops the hold; the newest release serves |

`KTHX_ORIGIN` points the client somewhere other than `https://kthx.dev`. The
token that opens a site is in `$XDG_CONFIG_HOME/kthx/sites.json` (0600), by
origin and name — never in the directory, which is what gets uploaded. There
is no account and no reset: a lost token is a lost site.

The package is not published. From a checkout, `bunx --bun kthx` at the repo
root runs it (the root `package.json` links the workspace bin), and
`bun apps/kthx/cli/main.ts` runs it from anywhere. Publishing, or a
`bun build --compile` binary, is the upgrade path.

An upload is a gzipped ustar of the directory without dotfiles,
`node_modules`, and `kthx.json`; symlinked files are carried as files. Like a
release, `kthx dev` treats a lone top-level directory as the site.
