# wiki

The static site generator behind [wiki.lolwtf.ca](https://wiki.lolwtf.ca). It
renders the repo's `docs/` tree with Bun: `build.ts` reads each page's YAML
frontmatter and Markdown body, orders the site by `docs/nav.yaml`, and writes
`dist/`. Page format and nav rules are in the home page's "Editing" section
(`docs/index.md`).

## What it builds

- One page per Markdown file, rendered by `Bun.markdown` with GitHub heading
  ids, GitHub alerts, tables, task lists and shiki-highlighted code (light and
  dark themes). `docs/agents/` is not rendered.
- The chrome: sidebar from `nav.yaml`, breadcrumbs, an "On this page" rail,
  previous/next in nav order, backlinks, and cards for any page whose
  frontmatter sets `cards:`.
- `search.json` for the ⌘K search, `graph.json` for `/graph/`, a `404.html`,
  and `/assets/` from `docs/assets/` plus the diagrams the kthx client ships
  in `apps/spindrift/src/web/client/diagrams/`.
- `pages.json`, each page's Markdown source in nav order, which the MCP
  endpoint in `functions/mcp.ts` serves at `/mcp` as `list_pages`,
  `read_page` and `search`.

The build fails, listing every problem, when a page lacks a title or
description, is missing from `nav.yaml`, has an H1 in its body, uses a Logseq
`[[link]]`, links with a scheme other than http(s) or mailto, or links to a
page, anchor, image or repo path that does not exist. `--manifest=FILE` also
writes every URL the site serves, anchors included; the docs contract
(`.github/scripts/docs-contract.sh`) resolves references from the rest of the
repo against it.

## Usage

```bash
bun install          # once, at the repo root (workspace member)
bun run check        # validate docs/ without writing dist/
bun run build        # docs/ → dist/
bun run dev          # build, then preview on :8787 (MCP at /mcp)
bun run test         # renderer and MCP tests against test/fixtures/
```

## Deploy

`.github/workflows/wiki.yml` builds and runs
`bun x wrangler pages deploy dist` into the Cloudflare Pages project
`infra-wiki` (`terraform/network/cloudflare/wiki.tf`). The Pages Function in
`functions/` deploys with it.
