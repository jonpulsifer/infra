/**
 * The command registry over MCP, as stateless streamable HTTP: one JSON-RPC
 * request in, one JSON response out. Tools come from `commandNames` alone.
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
import { MACHINE_NAME } from './brand.ts';

export const MCP_PATH = '/mcp';

const PROTOCOL_VERSION = '2025-06-18';

export interface McpRouteDeps {
  /**
   * `Authorization: Bearer` against agent rows only. Never accept the session
   * cookie: pasted into a config file, it loses `HttpOnly` and `Secure`.
   */
  authenticate(request: Request): Promise<RequestAuthentication>;
  context(principal: Principal): CommandContext | Promise<CommandContext>;
}

const TOOLS = commandNames.map((name) => ({
  name,
  description: commandRegistry[name].input.description ?? name,
  inputSchema: {
    // MCP requires an object schema, and Zod renders a discriminated union as a
    // bare `oneOf`. Spread second, so a schema's own `type` wins.
    type: 'object',
    ...z.toJSONSchema(commandRegistry[name].input, {
      // Transforms have no JSON Schema form. `any` keeps one such field from
      // failing the tool list, and `dispatch` still validates the input.
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
    // Clients probe with GET for an SSE stream, which this endpoint lacks.
    return new Response(`${MACHINE_NAME} MCP: POST JSON-RPC here\n`, {
      status: 405,
    });
  }

  // Before the body, so an anonymous caller cannot make this parse JSON.
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
        serverInfo: { name: MACHINE_NAME, version: '1' },
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
      // A refusal goes back as a tool result so the model can read the sentence
      // and act on it. A JSON-RPC error would hide it.
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

export const mcpToolNames: readonly CommandName[] = TOOLS.map(
  (tool) => tool.name,
);
