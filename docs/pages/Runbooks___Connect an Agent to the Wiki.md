icon:: 🔌
tags:: runbook

- The wiki serves itself over the Model Context Protocol at `https://wiki.lolwtf.ca/mcp`, so an agent that has never seen this repo can read the homelab documentation. Public and read-only, exactly like the site.
- ## Connect
	- Anything that speaks remote MCP over HTTP takes the URL directly. No token, no OAuth, no tailnet.
	- Claude Desktop: **Settings → Connectors → Add custom connector**, URL `https://wiki.lolwtf.ca/mcp`.
	- Claude Code: `claude mcp add --transport http homelab-wiki https://wiki.lolwtf.ca/mcp`
	- Anything reading a JSON config file:
		- ```json
		  {
		    "mcpServers": {
		      "homelab-wiki": { "type": "http", "url": "https://wiki.lolwtf.ca/mcp" }
		    }
		  }
		  ```
- ## The tools
	- `list_pages` — every page and its url. The cheapest way for an agent to learn what is documented.
	- `search` — full-text across every page, best matches with surrounding context.
	- `read_page` — one page in full, by name (`Architecture/Kubernetes`) or url path.
- ## Check it by hand
	- ```shell
	  curl -s https://wiki.lolwtf.ca/mcp -H 'content-type: application/json' \
	    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
	  ```
	- Expect `list_pages`, `search`, `read_page`. A `405` means the request was not a POST; this endpoint has no SSE stream to open.
- ## If it misbehaves
	- **Tools answer but the content is stale.** The endpoint reads `pages.json`, emitted by `apps/wiki/build.ts` alongside the rendered pages, so it is exactly as current as the site. Check that the `wiki` workflow ran on the merge.
	- **Every `tools/call` fails.** The function fetches `/pages.json` from the site's own assets — load `https://wiki.lolwtf.ca/pages.json` in a browser. Empty or missing means the build, not the endpoint, is broken.
	- **Nothing responds at all.** It is a Cloudflare Pages Function on the same project as the wiki (`apps/wiki/functions/mcp.ts`), deployed by `.github/workflows/wiki.yml`. If the site is up and `/mcp` is not, the Function failed to compile — read that workflow's deploy step.
- ## Changing it
	- The endpoint is one file, `apps/wiki/functions/mcp.ts`, with tests in `apps/wiki/functions/mcp.test.ts` run by `bun run test`. Adding a tool means adding it to `TOOLS` and to `call()`. It runs on the public internet with no authentication, so it only ever reads what this public site already publishes.
