---
title: Connect an agent to the wiki
description: Add the wiki's public, read-only MCP endpoint to Claude or another MCP client, and check that it answers.
---

This runbook adds the [wiki](../apps/wiki.md) to an agent through the Model Context Protocol (MCP), which lets an agent call tools on a server. Use it to give a new agent read access to the wiki, or when an agent cannot read it. The endpoint is `https://wiki.lolwtf.ca/mcp`. It is public and read-only, and it needs no token.

| Tool | Returns |
| --- | --- |
| `list_pages` | Every page by section, with its path and description |
| `search` | The 8 pages that match best, each with an excerpt |
| `read_page` | One page as Markdown, by path such as `apps/wiki`, by URL, by title, or by a relative link from another page |

## Before you start

- You need an MCP client that connects to remote servers over HTTP.
- To check the endpoint, you need `curl` and `jq`.

## Connect a client

1. If the client is Claude Code, add the server.

   ```bash
   claude mcp add --transport http homelab-wiki https://wiki.lolwtf.ca/mcp
   ```

   Result: The command prints `Added HTTP MCP server homelab-wiki with URL: https://wiki.lolwtf.ca/mcp to local config`.

2. If the client is Claude Desktop, open Settings > Connectors. Select Add custom connector. Enter the name `homelab-wiki` and the URL `https://wiki.lolwtf.ca/mcp`.
3. If the client reads a JSON config file, add this server to the file.

   ```json
   {
     "mcpServers": {
       "homelab-wiki": { "type": "http", "url": "https://wiki.lolwtf.ca/mcp" }
     }
   }
   ```

4. Start a new session in the client.
5. Tell the agent to list the wiki pages.

   Result: The agent calls `list_pages` and shows the pages by section.

## Check the endpoint

1. List the tools.

   ```bash
   curl -s https://wiki.lolwtf.ca/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'
   ```

   Result: The command prints `list_pages`, `search` and `read_page`, one on each line.

2. Read one page.

   ```bash
   curl -s https://wiki.lolwtf.ca/mcp -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_page","arguments":{"page":"apps/wiki"}}}' \
     | jq -r '.result.content[0].text' | head -2
   ```

   Result: The command prints `# Wiki` and `https://wiki.lolwtf.ca/apps/wiki/`.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| The endpoint returns `405`. | The request is not a POST. The endpoint accepts only POST. | Send JSON-RPC requests with POST. |
| A tool returns old content. | The `wiki` workflow did not deploy the last change on `main`. | Read the last run of `.github/workflows/wiki.yml` on `main`. |
| `tools/list` answers, and every `tools/call` fails. | `pages.json` is empty or missing. | Open `https://wiki.lolwtf.ca/pages.json`. If it is empty or missing, read the Build step of the `wiki` workflow. |
| The site answers, and `/mcp` does not. | The Pages Function did not deploy. | Read the Deploy step of the `wiki` workflow. |

## Related

- [Wiki](../apps/wiki.md)
- [Connect an agent to kthx](connect-an-agent-to-kthx.md)
