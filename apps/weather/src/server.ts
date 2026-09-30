/**
 * `GET /v1/<operation>` for apps and `POST /mcp` for agents, over one
 * registry. MCP runs stateless: each request gets its own server and
 * transport, so any replica answers any request.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { type Deps, type Operation, operations } from './operations.ts';
import { PlaceNotFound } from './places.ts';

export const MCP_PATH = '/mcp';

const INSTRUCTIONS =
  'Canadian weather from Environment Canada (MSC GeoMet) and the family Tempest stations. Places default to home, the first configured place; call places to see them. Units are metric. Times are local to the place.';

export const route = (op: Operation) => op.name.replaceAll('_', '-');

function mcpServer(deps: Deps): McpServer {
  const server = new McpServer(
    { name: 'weather', version: '1' },
    { instructions: INSTRUCTIONS },
  );
  for (const op of operations) {
    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: op.input,
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await op.run(args, deps);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: message(error) }],
          };
        }
      },
    );
  }
  return server;
}

function message(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((i) => `${i.path.join('.') || 'input'}: ${i.message}`)
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

function status(error: unknown): 400 | 404 | 502 {
  if (error instanceof z.ZodError) return 400;
  if (error instanceof PlaceNotFound) return 404;
  return 502;
}

// Query strings are text; the schema says which fields are numbers.
function fromQuery(
  op: Operation,
  query: Record<string, string>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    let schema = op.input[key];
    while (schema instanceof z.ZodOptional) schema = schema.unwrap();
    args[key] =
      schema instanceof z.ZodNumber && value.trim() !== ''
        ? Number(value)
        : value;
  }
  return args;
}

export function app(deps: Deps): Hono {
  const web = new Hono();

  web.get('/healthz', (c) => c.text('ok\n'));

  web.get('/v1', (c) =>
    c.json({
      operations: operations.map((op) => ({
        path: `/v1/${route(op)}`,
        mcpTool: op.name,
        title: op.title,
        description: op.description,
        parameters: Object.keys(op.input),
      })),
      mcp: MCP_PATH,
    }),
  );

  for (const op of operations) {
    web.get(`/v1/${route(op)}`, async (c) => {
      try {
        return c.json(await op.run(fromQuery(op, c.req.query()), deps));
      } catch (error) {
        return c.json({ error: message(error) }, status(error));
      }
    });
  }

  web.all(MCP_PATH, async (c) => {
    if (c.req.method !== 'POST') {
      // Stateless: no SSE stream to open and no session to delete.
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Method not allowed' },
          id: null,
        },
        405,
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = mcpServer(deps);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });

  return web;
}
