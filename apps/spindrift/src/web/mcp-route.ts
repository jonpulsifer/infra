/**
 * `/mcp` — the command registry, served over the Model Context Protocol.
 *
 * This is the second transport onto the same command layer, and it adds no
 * decision of its own: `tools/list` is `commandRegistry` with each Zod input
 * rendered as JSON Schema, and `tools/call` is {@link dispatch}. §21's "a later
 * thin API or CLI can wrap them without reconstructing the domain from UI
 * handlers" is the sentence this file is the first proof of — every act it
 * exposes was already an act, and there is no command here that the browser
 * does not have.
 *
 * **Generated, exactly as `dispatch.ts` is.** The tool list is built from
 * `commandNames` and nothing else, so a tool that is not a command cannot be
 * written, and a command added to the registry is reachable here the moment it
 * is reachable there. There is no allow-list to keep in step, which is
 * deliberate: an allow-list is a second list, and a second list is the thing
 * `registry.ts` exists to abolish.
 *
 * **Its own credential, read from its own header.** {@link McpRouteDeps} takes
 * an `authenticate` that resolves `Authorization: Bearer` against `agent` rows
 * only (`src/auth/session.ts`). It is not `DispatchDeps.authenticate` and must
 * never become it: a resolver that fell back from bearer to cookie would make
 * a browser cookie sitting in an agent's config file work, and that value
 * losing `HttpOnly`, `Secure` and `SameSite=Lax` the moment it is copied out of
 * a browser is the whole reason agent tokens exist.
 *
 * Stateless streamable HTTP: one JSON-RPC request in, one JSON response out.
 * No sessions, no SSE. Same shape `apps/wiki/functions/mcp.ts` serves the wiki
 * with, for the same reason — it is the least protocol that works.
 */

import { z } from 'zod';
import type { RequestAuthentication } from '../auth/types.ts';
import {
  type CommandName,
  commandNames,
  commandRegistry,
  dispatch,
} from '../commands/registry.ts';
import type { CommandContext, Principal } from '../commands/types.ts';

export const MCP_PATH = '/mcp';

/** The protocol revision this endpoint speaks. */
const PROTOCOL_VERSION = '2025-06-18';

export interface McpRouteDeps {
  /**
   * Who is calling, from `Authorization: Bearer` and nowhere else.
   *
   * The same `RequestAuthentication` shape the dispatch surface uses, so a
   * `forbidden` verdict — a Gateway identity that is asserted but unlinked —
   * reads the same here as there.
   */
  authenticate(request: Request): Promise<RequestAuthentication>;
  context(principal: Principal): CommandContext | Promise<CommandContext>;
}

/**
 * One tool per command.
 *
 * Built once at module load: the registry is a module-level constant and
 * `z.toJSONSchema` is pure, so re-deriving this per request would be work with
 * no possible new answer.
 *
 * The description is the input schema's own, where a command's author wrote
 * one. Where none exists the name is the honest fallback — a made-up sentence
 * here would be a second description of the command living somewhere its author
 * will never look, and a wrong one is worse for a model than a terse one.
 */
const TOOLS = commandNames.map((name) => ({
  name,
  description: commandRegistry[name].input.description ?? name,
  inputSchema: {
    /**
     * MCP requires every `inputSchema` to be an object schema, and a few
     * commands take a discriminated union — `createComponent` and
     * `connectTarget` — which Zod renders as a bare `oneOf` with no top-level
     * `type`. A client that insists on the spec drops those two tools, and it
     * is right to.
     *
     * `type` and `oneOf` are independent keywords that must both hold, and
     * every variant of those unions is itself an object, so asserting it here
     * narrows nothing and makes the document say what is already true. The
     * spread runs second so a schema that already declares its own `type`
     * keeps it.
     */
    type: 'object',
    ...z.toJSONSchema(commandRegistry[name].input, {
      // The registry's schemas are written for `safeParse`, not for
      // publication: some carry transforms and defaults that have no JSON
      // Schema equivalent. Emitting the closest input-side shape keeps one
      // unrepresentable field from taking the whole tool list down, and
      // `dispatch` still validates for real — a model that sends the wrong
      // thing gets INVALID_INPUT naming the failing fields, which is the same
      // answer the browser gets.
      io: 'input',
      unrepresentable: 'any',
    }),
  },
}));

const json = (body: unknown, status = 200) => Response.json(body, { status });

const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  json({ jsonrpc: '2.0', id, error: { code, message } }, status);

export function mcpRoutes(
  deps: McpRouteDeps,
): Record<string, (request: Request) => Promise<Response>> {
  return { [MCP_PATH]: (request) => handle(request, deps) };
}

async function handle(request: Request, deps: McpRouteDeps): Promise<Response> {
  if (request.method !== 'POST') {
    // Clients probe with GET before opening an SSE stream; this endpoint has
    // none, and every tool here is an act besides.
    return new Response('spindrift MCP: POST JSON-RPC here\n', { status: 405 });
  }

  // Authenticate before reading the body: an anonymous caller should not be
  // able to make this process parse arbitrary JSON, and it costs nothing to
  // ask first.
  const authentication = await deps.authenticate(request);
  if (authentication.kind === 'anonymous') {
    return rpcError(
      null,
      -32001,
      'this surface needs an agent token — mint one with the mintAgentToken command while signed in',
      401,
    );
  }
  if (authentication.kind === 'forbidden') {
    return rpcError(null, -32001, authentication.message, 403);
  }
  const { principal } = authentication;

  let rpc: {
    id?: unknown;
    method?: string;
    params?: { name?: string; arguments?: unknown };
  };
  try {
    rpc = (await request.json()) as typeof rpc;
  } catch {
    return rpcError(null, -32700, 'the request body is not JSON', 400);
  }

  const reply = (result: unknown) =>
    json({ jsonrpc: '2.0', id: rpc.id, result });

  switch (rpc.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'spindrift', version: '1' },
      });
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = rpc.params?.name ?? '';
      const result = await dispatch(
        name,
        rpc.params?.arguments ?? {},
        await deps.context(principal),
      );
      // A refusal is a tool result, not a protocol error: the model is meant to
      // read the sentence and act on it — deploy a Build that has not
      // succeeded, delete an App that is locked — exactly as an operator reads
      // it off a disabled button. A JSON-RPC error would hide that sentence
      // behind a transport fault the model cannot do anything with.
      return reply({
        isError: !result.ok,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              result.ok ? result.value : result.failure,
              null,
              2,
            ),
          },
        ],
      });
    }
    default:
      // Notifications carry no id and expect no body.
      if (rpc.id === undefined) return new Response(null, { status: 202 });
      return rpcError(rpc.id, -32601, `unknown method ${rpc.method}`);
  }
}

/** Exported for the test that asserts tools and commands are the same set. */
export const mcpToolNames: readonly CommandName[] = TOOLS.map(
  (tool) => tool.name,
);
