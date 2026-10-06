---
title: Connect an agent to kthx
description: Mint an agent token in the kthx console and connect an MCP client, Rowbutt or the owner's workstation to the kthx engine, which serves each console command as a tool.
---

Use this runbook to give an MCP client the commands of the kthx built-apps console. The kthx engine on offsite serves each command in `apps/kthx-engine/src/commands/registry.ts` as a Model Context Protocol (MCP) tool at `https://spindrift-control.lolwtf.dev/mcp`. The endpoint accepts only an agent token, which you mint in the console at `https://kthx.lolwtf.ca`. A token lasts 90 days. The console shows it once, because kthx stores only its SHA-256 hash.

## Before you start

- Get a passkey on the installation ([Install kthx](install-kthx.md)).
- The console resolves to a private address, so your browser must reach the offsite network. The Cloudflare tunnel forwards `/mcp` from the internet. [kthx](../apps/kthx.md#use-it) lists both addresses, and `hostname` and `SPINDRIFT_PUBLIC_HOSTNAME` in `clusters/offsite/apps/spindrift/helm-release.yaml` declare them.
- Get an MCP client that speaks streamable HTTP, such as Claude Code.

## Mint an agent token

> [!NOTE]
> An agent token cannot mint another token. The browser session cookie does not work as a bearer token.

1. Open `https://kthx.lolwtf.ca`.
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

5. Ask the client to call `getDeveloperSurfaces`. The tool is read-only.

   Result: The endpoint's private and public URLs, and the quick-site origin and zone.

## Give Rowbutt a token

[Rowbutt](../apps/mate.md) runs every command without approval, so the warning above applies in full. mate reaches the engine in the cluster, and the ExternalSecret `mate-kthx-agent` in namespace `mate` gives mate the token as `KTHX_AGENT_TOKEN`. mate bridges the engine's tools into the agent as `kthx_*` tools. mate reads the token when it starts. Reloader restarts mate when the Secret changes, but not when the first sync creates the Secret.

1. Mint an agent token as above.
2. In the `homelab` vault in 1Password, create an API Credential item titled `mate kthx agent token`.
3. Put the token in the item's `credential` field.
4. Make sure the ExternalSecret has synced. It refreshes on its interval.

   ```bash
   kubectl --context offsite -n mate get externalsecret mate-kthx-agent
   ```

   Result: `STATUS` is `SecretSynced`.

5. Read how long ago mate started.

   ```bash
   kubectl --context offsite -n mate get pods -l app.kubernetes.io/name=mate
   ```

   Result: The pod is `Running`, and its `AGE` is the time since it started.

6. If mate started before the sync, restart mate.

   ```bash
   kubectl --context offsite -n mate rollout restart deploy/mate
   ```

   Result: `deployment.apps/mate restarted`.

7. In a Rowbutt thread, ask which `kthx` tools the agent has.

   Result: Rowbutt names tools whose names start with `kthx_`.

A revoked or expired token makes the engine refuse mate. After the next restart the agent has no `kthx_*` tools, and until then their calls fail. Mint a new token, and update the item.

## Give the workstation a token

The `mate` pi package connects pi on the owner's workstation to the engine. `dotfiles/pi/mate/extensions/mcp.ts` reads the token with `op read` when pi starts, so the token never enters pi's environment. pi names the tools `mcp__kthx__*`.

> [!WARNING]
> pi asks for no approval before each call, so the warning in [Connect a client](#connect-a-client) applies in full. The owner accepts this for the workstation token.

1. Mint an agent token as above. Do not use Rowbutt's token.
2. In the `homelab` vault in 1Password, create an API Credential item titled `workstation kthx agent token`.
3. Put the token in the item's `credential` field.
4. Put the date 90 days after the mint in the item's `expires` field.
5. Make sure that the item resolves. The command does not print the token.

   ```bash
   op read 'op://homelab/workstation kthx agent token/credential' >/dev/null && echo resolves
   ```

   Result: The command prints `resolves`.

6. Start pi from a shell where `op` is signed in.
7. Ask pi to call the kthx tool `getDeveloperSurfaces`. The tool is read-only.

   Result: The endpoint's private and public URLs, and the quick-site origin and zone.

The extension sends this `Authorization` header, a command that pi runs in a shell:

```text
!t=$(op read 'op://homelab/workstation kthx agent token/credential') && printf 'Bearer %s' "$t"
```

If `op` fails, pi reports that `kthx` failed and starts without it. pi reads the token once when it starts, so restart pi after you replace the token.

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
