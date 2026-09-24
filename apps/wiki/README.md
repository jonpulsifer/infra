# wiki

wiki is the Bun static site generator for [wiki.lolwtf.ca](https://wiki.lolwtf.ca).
It renders the `docs/` tree of the repo into `dist/`. See
[Wiki](https://wiki.lolwtf.ca/apps/wiki/), and the
[Style guide](https://wiki.lolwtf.ca/reference/style-guide/) for the page
rules.

## Run and test

```bash
bun install          # once, at the repo root
bun run check        # validate docs/ and write nothing
bun run build        # docs/ to dist/
bun run dev          # build, then serve on http://localhost:8787 with MCP at /mcp
bun run test         # renderer and MCP tests against test/fixtures/
```

`mise run docs:check` at the repo root runs `check` and the docs contract,
`.github/scripts/docs-contract.sh`.

## Code

- `build.ts` reads the frontmatter and Markdown of each page, orders the site
  by `docs/nav.yaml`, and writes each page, `search.json`, `graph.json`,
  `pages.json` and `404.html`. It does not render `docs/agents/`.
- `build.ts` copies `docs/assets/` and the diagrams in
  `apps/spindrift/src/web/client/diagrams/` to `/assets/`.
- `functions/mcp.ts` serves `pages.json` at `/mcp` as the tools `list_pages`,
  `read_page` and `search`.
- The build fails and lists each problem: missing frontmatter, a page missing
  from `nav.yaml`, an H1 in a body, a `[[link]]`, a link scheme other than
  http(s) or mailto, or a link to a page, anchor, image or path that does not
  exist. `--manifest=FILE` writes each URL the site serves, which the docs
  contract checks references against.

## Deploy

On merge to `main`, `.github/workflows/wiki.yml` builds the site and runs
`bun x wrangler pages deploy dist` into the Cloudflare Pages project
`infra-wiki` (`terraform/network/cloudflare/wiki.tf`). The Pages Function in
`functions/` deploys with it.
