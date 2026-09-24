---
title: Wiki
description: This documentation site at wiki.lolwtf.ca, which a Bun renderer builds from docs/ and Cloudflare Pages serves, with a read-only MCP endpoint for agents.
status: live
---

The wiki is this site. `apps/wiki/build.ts` renders the Markdown files in `docs/` into a static site, and Cloudflare Pages serves it at `wiki.lolwtf.ca`. The owner and agents read it. Agents use an MCP (Model Context Protocol) endpoint, which serves the same pages as tools. The site is public, so no page holds a secret.

## Use it

| Surface | Address | Who can reach it |
| --- | --- | --- |
| Site | `https://wiki.lolwtf.ca` | Anyone |
| Search | ⌘K or Ctrl+K on any page | Anyone |
| Page graph | `https://wiki.lolwtf.ca/graph/` | Anyone |
| MCP endpoint | `https://wiki.lolwtf.ca/mcp` | Any MCP client, with no sign-in. See [Connect an agent to the wiki](../runbooks/connect-an-agent-to-the-wiki.md). |

To change a page, edit its file in `docs/` and merge a pull request. The [style guide](../reference/style-guide.md) has the rules and page templates. `docs/nav.yaml` sets the order of the pages.

## Limits

- The build fails if a page has no title or description, or is not in `docs/nav.yaml`.
- The build also fails if a page has an H1 in its body, or links to a missing page, anchor or repo path.
- The site has no redirects. A renamed page breaks every link to its old URL.
- A change is live only after it merges to `main`. A pull request builds the site and does not deploy it.

## How it works

The renderer writes one HTML page for each Markdown file. It also writes `search.json` for search, `graph.json` for the graph, and `pages.json`, which holds the Markdown of every page in nav order.

`.github/workflows/wiki.yml` runs on a change to `docs/`, `apps/wiki/` or any Markdown file in the repository. It runs the docs contract (`.github/scripts/docs-contract.sh`), the renderer tests and the build. On `main`, it deploys `dist/` to the Cloudflare Pages project `infra-wiki` with `wrangler`. The contract also rejects history words and checks links into the wiki from other files.

The MCP endpoint is a Pages Function, `apps/wiki/functions/mcp.ts`, that deploys with the site. It reads `pages.json` from the site for each tool call, so it serves the same version as the site. It has no authentication, so a tool returns only what the site already publishes. To add a tool, add it to `TOOLS` and `call()` and test it in `apps/wiki/test/mcp.test.ts`.

## Operate

No alerts watch the wiki. Before you push a docs change, run `mise run docs:check`.

## Reference

- Source: `apps/wiki/`
- Pages: `docs/`
- Deploy: `.github/workflows/wiki.yml`
- Pages project and DNS record: `terraform/network/cloudflare/wiki.tf`
