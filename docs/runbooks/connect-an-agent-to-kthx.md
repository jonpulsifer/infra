---
title: Connect an agent to kthx
description: Mint an agent token in the kthx console and connect an MCP client to the kthx engine, which serves each console command as a tool.
---

Use this runbook to give an MCP client the commands of the kthx built-apps console. The kthx engine on offsite serves each command in `apps/spindrift/src/commands/registry.ts` as a Model Context Protocol (MCP) tool at `https://spindrift-control.lolwtf.dev/mcp`. The endpoint accepts only an agent token, which you mint in the console at `https://spindrift.lolwtf.ca`. A token lasts 90 days. The console shows it once, because kthx stores only its SHA-256 hash.

## Before you start

- Get a passkey on the installation ([Install kthx](install-kthx.md)).
- The console resolves to a private address, so your browser must reach the offsite network. The Cloudflare tunnel forwards `/mcp` from the internet. [kthx](../apps/kthx.md#use-it) lists both addresses, and `hostname` and `SPINDRIFT_PUBLIC_HOSTNAME` in `clusters/offsite/apps/spindrift/helm-release.yaml` declare them.
- Get an MCP client that speaks streamable HTTP, such as Claude Code.

## Mint an agent token

> [!NOTE]
> An agent token cannot mint another token. The browser session cookie does not work as a bearer token.

1. Open `https://spindrift.lolwtf.ca`.
2. Sign in with your passkey.
3. Go to Settings, then Identity.
4. In the "Agent tokens" card, select "Mint an agent token".

   Result: The card shows the token and "Copy this now — it is not shown again."

5. Copy the token into your password manager.

## Connect a client

> [!WARNING]
> An agent token can run every command except the ones [Ownership and security](../apps/kthx/security.md#identities) lists, including the commands that delete Apps and Datastores. No token is read-only. Use a client that asks you to approve each call.

1. Store the token in the `TOKEN` variable.

   ```bash
   read -rs TOKEN
   ```

   Paste the token, then press Enter. The shell does not show the token.

2. If the client is Claude Code, add the server.

   ```bash
   claude mcp add --transport http kthx https://spindrift-control.lolwtf.dev/mcp --header "Authorization: Bearer $TOKEN"
   ```

   Result: The command prints `Added HTTP MCP server kthx with URL: https://spindrift-control.lolwtf.dev/mcp to local config`.

3. If the client reads a JSON file, add the server to it.

   ```json
   {
     "mcpServers": {
       "kthx": {
         "type": "http",
         "url": "https://spindrift-control.lolwtf.dev/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

4. Make sure the endpoint lists its tools.

   ```bash
   curl -s https://spindrift-control.lolwtf.dev/mcp \
     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'
   ```

   Result: A number larger than zero.

## Give Rowbutt a token

[Rowbutt](../apps/mate.md) runs every command without approval, so the warning above applies in full. Its sandboxes reach the engine in the cluster, and the ExternalSecret `mate-kthx-agent` in namespace `mate` hands each sandbox the token as `KTHX_AGENT_TOKEN`.

1. Mint an agent token as above.
2. In the `homelab` vault in 1Password, create an API Credential item titled `mate kthx agent token`.
3. Put the token in the item's `credential` field.
4. Make sure the ExternalSecret has synced. It refreshes on its interval.

   ```bash
   kubectl --context offsite -n mate get externalsecret mate-kthx-agent
   ```

   Result: `STATUS` is `SecretSynced`.

5. Delete the ready spare. A sandbox reads the Secret when its pod is created, and the spare was created before the sync.

   ```bash
   kubectl --context offsite -n mate delete sandbox -l lolwtf.ca/spare=true
   ```

   Result: `sandbox.agents.x-k8s.io "mate-spare-<id>" deleted`, and mate mints a new spare within five minutes.

A revoked or expired token makes the `kthx` server fail when OpenCode starts a session, and the agent reports that it has no `kthx` tools. Mint a new token, update the item, and delete the spare again.

## Revoke a token

1. Go to Settings, then Identity, in the console.
2. In the "Agent tokens" card, find the token by its mint date and last use.
3. Select "Revoke".

   Result: The card does not list the token. Your browser session stays signed in.

## If something goes wrong

| Symptom | Cause | Action |
| --- | --- | --- |
| HTTP 401 with "this surface needs an agent token". | The token is missing, expired, revoked, or a browser cookie. | Mint a new agent token. |
| HTTP 405 with "POST JSON-RPC here". | The request is not a POST. | Use POST. The endpoint does not stream Server-Sent Events (SSE). |
| HTTP 404 on `/mcp`. | The host is not a kthx engine host. | Use `https://spindrift-control.lolwtf.dev/mcp`. |
| A tool result has `isError` set to `true`. | kthx refused the command. The text has a code, such as `NOT_DEPLOYABLE` or `INVALID_INPUT`, and the sentence the console shows. | Correct the input as the sentence tells you. Call the tool again. |
| A tool result has the code `FORBIDDEN`. | An agent token called `mintAgentToken`. | Mint tokens in the console. |

## Related

- [Built apps](../apps/kthx/built-apps.md)
- [Connect an agent to the wiki](connect-an-agent-to-the-wiki.md)
