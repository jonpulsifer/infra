// The MCP tool list is the command registry, and the route reads nothing but
// its own `authenticate`, so a browser cookie cannot open it. Every path here
// refuses or answers before a handler runs; `unreachableContext` throws if one does not.
import { describe, expect, spyOn, test } from 'bun:test';
import { commandNames } from '../../src/commands/registry.ts';
import type { Principal } from '../../src/commands/types.ts';
import { MACHINE_NAME } from '../../src/web/brand.ts';
import {
  MCP_PATH,
  type McpRouteDeps,
  mcpRoutes,
} from '../../src/web/mcp-route.ts';
import { unreachableContext } from '../harness/context.ts';
import {
  cloudflareInput,
  cloudInput,
  clusterInput,
  vercelInput,
} from '../harness/installation.ts';

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
      // A model chooses a tool by its description.
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test('initialize answers with tools capability', async () => {
    const { result } = await call(authenticated, 'initialize');
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe(MACHINE_NAME);
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

describe('an agent token cannot widen its own standing', () => {
  const agent: McpRouteDeps = {
    authenticate: async () => ({
      kind: 'authenticated',
      principal: { ...OPERATOR, kind: 'agent' },
    }),
    context: (principal) => ({ ...context, principal }),
  };

  test('mintAgentToken is refused as a tool result, before anything is written', async () => {
    const response = await handler(agent)(
      rpc('tools/call', { name: 'mintAgentToken', arguments: {} }),
    );
    expect(response.status).toBe(200);
    const { result } = await response.json();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: 'FORBIDDEN',
      message:
        'an agent token cannot mint another — sign in and mint one from Settings',
    });
  });

  test('configureInstallation is refused, so it cannot rewrite auth.gateway', async () => {
    const response = await handler(agent)(
      rpc('tools/call', {
        name: 'configureInstallation',
        arguments: { manifest: {} },
      }),
    );
    const { result } = await response.json();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('FORBIDDEN');
  });

  describe('an endpoint the installation authenticates to is not the agent’s to name', () => {
    // A connect or probe presents the installation's own credentials to these.
    const collector = 'https://collector.example.test';
    const calls = [
      ['connectTarget', clusterInput({ apiServer: collector })],
      [
        'connectTarget',
        cloudInput({
          runEndpoint: collector,
          hostingEndpoint: collector,
          policyEndpoint: collector,
        }),
      ],
      ['connectTarget', vercelInput({ endpoint: collector })],
      ['connectTarget', cloudflareInput({ endpoint: collector })],
      ['probeCluster', { apiServer: collector }],
    ] as const;

    for (const [name, args] of calls) {
      test(`${'kind' in args ? `${name} for a ${args.kind}` : name} is refused before any request leaves`, async () => {
        const outbound = spyOn(globalThis, 'fetch');
        try {
          const response = await handler(agent)(
            rpc('tools/call', { name, arguments: args }),
          );
          const { result } = await response.json();
          expect(result.isError).toBe(true);
          expect(JSON.parse(result.content[0].text).code).toBe('FORBIDDEN');
          expect(outbound).not.toHaveBeenCalled();
        } finally {
          outbound.mockRestore();
        }
      });
    }
  });
});

describe('protocol', () => {
  test('an unknown tool is a tool result, not a transport error', async () => {
    // As a tool result, the model can read the refusal and pick a real tool.
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
