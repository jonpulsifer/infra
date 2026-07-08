# wiki

A ~400-line Bun static site generator that renders the repo's `docs/` Logseq
graph to [wiki.lolwtf.ca](https://wiki.lolwtf.ca). It replaced
`logseq/publish-spa` (which cloned and compiled the entire Logseq frontend in
CI, ~20 min cold) with a build that takes about a second.

## What it understands

Logseq outline markdown, as written by the Logseq desktop app:

- `- ` blocks with tab nesting; continuation lines (code fences, tables)
- `key:: value` page properties → chips (`status::` gets ADR colors)
- `[[wikilinks]]` (+ backlinks collected into a "Linked references" panel)
- `#tags` and `tags::` → generated tag pages
- headings, tables, inline markdown, and shiki-highlighted code fences
  (dual light/dark themes)

It also emits a client-side search index (⌘K), a canvas force-directed
graph view (`/graph/`), namespace sub-page listings, journals, and a 404.

## Usage

```bash
bun install          # once, at repo root (workspace member)
bun run build        # docs/ → dist/
bun run dev          # build + preview on :8787
```

Deployed by `.github/workflows/wiki.yml`: build, then
`bun x wrangler pages deploy dist` to the Cloudflare Pages project
`infra-wiki` (Terraform: `terraform/network/cloudflare/wiki.tf`).
