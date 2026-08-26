/**
 * `/mcp`, the command registry over MCP.
 *
 * Two things are worth asserting here and nothing else is. The first is that
 * the tool list *is* the registry — the same set-equality `dispatch.test.ts`
 * makes about routes, because the same drift (a tool that is not a command, a
 * command that is not a tool) is the same failure seen from two sides.
 *
 * The second is that this surface has its own key. A browser cookie must not
 * open it, which is the property the `kind` column exists for and the reason
 * `serve.ts` hands it `resolveAgentToken` rather than `authenticateRequest`.
 * That half is asserted against a real database in
 * `test/auth/agent-token.test.ts`; what is asserted here is that this route
 * reads nothing but its own `authenticate`.
 *
 * No database: every path under test refuses or answers before a handler runs,
 * and `unreachableContext` throws if one does not.
 */
import { describe, expect, test } from 'bun:test';
import { commandNames } from '../../src/commands/registry.ts';
import type { Principal } from '../../src/commands/types.ts';
import {
  MCP_PATH,
  type McpRouteDeps,
  mcpRoutes,
} from '../../src/web/mcp-route.ts';
import { unreachableContext } from '../harness/context.ts';

const context = await unreachableContext();

const OPERATOR: Principal = {
  id: crypto.randomUUID(),
  displayName: 'Operator',
};

const authenticated: McpRouteDeps = {
  authenticate: async () => ({ kind: 'authenticated', principal: OPERATOR }),
  context: () => context,
};

const anonymous: McpRouteDeps = {
  authenticate: async () => ({ kind: 'anonymous' }),
  context: () => {
    throw new Error('an unauthenticated request built a request context');
  },
};

function handler(deps: McpRouteDeps) {
  return mcpRoutes(deps)[MCP_PATH] as (request: Request) => Promise<Response>;
}

function rpc(method: string, params?: unknown, id: unknown = 1): Request {
  return new Request(`https://spindrift.example.test${MCP_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
}

async function call(
  deps: McpRouteDeps,
  method: string,
  params?: unknown,
): Promise<any> {
  const response = await handler(deps)(rpc(method, params));
  return response.json();
}

describe('the tool list is the registry', () => {
  test('every command is a tool, and nothing else is', async () => {
    const { result } = await call(authenticated, 'tools/list');
    expect(result.tools.map((t: { name: string }) => t.name).sort()).toEqual(
      [...commandNames].sort(),
    );
  });

  test('every tool carries an object input schema a client can read', async () => {
    const { result } = await call(authenticated, 'tools/list');
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      // A model picks a tool off this string; an empty one is a tool it cannot
      // choose. The name is the floor, and the floor has to be non-empty.
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test('initialize answers with tools capability', async () => {
    const { result } = await call(authenticated, 'initialize');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('spindrift');
  });
});

describe('this surface has its own key', () => {
  test('nobody behind the request is 401, and no context is built', async () => {
    const response = await handler(anonymous)(rpc('tools/list'));
    expect(response.status).toBe(401);
  });

  test('a forbidden identity is 403', async () => {
    const response = await handler({
      authenticate: async () => ({
        kind: 'forbidden',
        message: 'that Gateway identity is not linked',
      }),
      context: () => {
        throw new Error('a forbidden request built a request context');
      },
    })(rpc('tools/list'));
    expect(response.status).toBe(403);
  });

  test('GET is refused — every tool here is an act', async () => {
    const response = await handler(authenticated)(
      new Request(`https://spindrift.example.test${MCP_PATH}`),
    );
    expect(response.status).toBe(405);
  });
});

describe('protocol', () => {
  test('an unknown tool is a tool result, not a transport error', async () => {
    // The model is meant to read the sentence and pick a real tool, which it
    // cannot do if the refusal arrives as a JSON-RPC error it has no handler
    // for.
    const { result } = await call(authenticated, 'tools/call', {
      name: 'noSuchCommand',
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('UNKNOWN_COMMAND');
  });

  test('an unknown method is a JSON-RPC error', async () => {
    const { error } = await call(authenticated, 'resources/list');
    expect(error.code).toBe(-32601);
  });

  test('a notification gets no body', async () => {
    const response = await handler(authenticated)(
      new Request(`https://spindrift.example.test${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }),
    );
    expect(response.status).toBe(202);
  });

  test('a body that is not JSON is a parse error', async () => {
    const response = await handler(authenticated)(
      new Request(`https://spindrift.example.test${MCP_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32700);
  });
});
