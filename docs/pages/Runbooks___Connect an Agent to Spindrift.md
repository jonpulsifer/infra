icon:: 🤖
tags:: runbook

- Spindrift serves its command registry over the Model Context Protocol at `https://spindrift-control.lolwtf.dev/mcp`, so an agent can drive the platform — list apps, dispatch a build, deploy, roll back — through the same commands the UI dispatches. Unlike [[Runbooks/Connect an Agent to the Wiki]] this surface is **authenticated and it writes**. Every tool is an act.
- ## Mint a token
	- The MCP endpoint takes an **agent token**, never the browser session cookie. They are both rows in `sessions` and the `kind` column keeps them apart: a cookie presented as a bearer token is refused, and an agent token presented as a cookie is refused. That is deliberate — a cookie loses `HttpOnly`, `Secure` and `SameSite=Lax` the moment it is copied into a config file, so the credential that lives in a file is a different credential.
	- Sign in with your passkey, then dispatch `mintAgentToken`. There is no screen for it yet, so from the browser console on the Spindrift tab:
		- ```js
		  await (await fetch('/internal/commands/mintAgentToken', {
		    method: 'POST',
		    headers: { 'content-type': 'application/json' },
		    body: '{}',
		  })).json()
		  ```
	- The `token` in the reply is shown once and never again — the row holds only its SHA-256. It lasts ninety days.
	- `listAgentTokens` names the rows you hold by id and date, and `revokeAgentToken` takes one of those ids. Revoking an agent token does not touch your browser session, which is the reason they are separate rows.
- ## Connect
	- Claude Code: `claude mcp add --transport http spindrift https://spindrift-control.lolwtf.dev/mcp --header "Authorization: Bearer $TOKEN"`
	- Anything reading a JSON config file:
		- ```json
		  {
		    "mcpServers": {
		      "spindrift": {
		        "type": "http",
		        "url": "https://spindrift-control.lolwtf.dev/mcp",
		        "headers": { "Authorization": "Bearer THE-TOKEN" }
		      }
		    }
		  }
		  ```
- ## The tools
	- One tool per command, generated from `apps/spindrift/src/commands/registry.ts`. There is no allow-list to keep in step: a command that exists in the registry is a tool, and a tool that is not a command cannot be written. `tools/list` is the current answer and this page deliberately does not restate it.
	- A command's refusal comes back as a tool result carrying its code and sentence — `NOT_DEPLOYABLE`, `STALE_EDIT`, `INVALID_INPUT` with the failing fields — not as a transport error, so an agent reads the same sentence an operator reads off a disabled button.
	- Every tool is an act and there are no read-only tokens. What stands between an agent and a destructive command is the client's own per-call confirmation, so connect this to a client that asks.
- ## Check it by hand
	- ```shell
	  curl -s https://spindrift-control.lolwtf.dev/mcp \
	    -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
	    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
	  ```
	- A `401` means the token is not an agent token — a browser cookie will get exactly this. A `405` means the request was not a POST; this endpoint has no SSE stream to open.
- ## Changing it
	- The endpoint is `apps/spindrift/src/web/mcp-route.ts`, tested in `apps/spindrift/test/web/mcp-route.test.ts`. It holds no domain logic: `tools/list` renders each command's Zod input as JSON Schema and `tools/call` is `dispatch`. Adding a tool means adding a command.
	- The credential lives in `apps/spindrift/src/auth/session.ts` with its crossed-key tests in `apps/spindrift/test/auth/agent-token.test.ts`. The three commands behind it are `apps/spindrift/src/commands/agent-tokens.ts`.
