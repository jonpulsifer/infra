import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Network } from '@x402/core/types';
import {
  createPaymentWrapper,
  MCP_PAYMENT_META_KEY,
  type MCPToolCallback,
  type x402ResourceServer,
} from '@x402/mcp';

type Args = Record<string, unknown>;
export type Tool = {
  price: string;
  description: string;
  input?: Record<string, unknown>;
  /** Refuse before payment; the message becomes an isError result. */
  guard?: (args: Args) => string | undefined;
  /** `seed` is the payment payload as JSON; an `{ error }` is not settled. */
  run: (args: Args, seed: string) => Promise<string | { error: string }>;
};

const text = (t: string, isError = false) => ({
  content: [{ type: 'text' as const, text: t }],
  isError,
});

/** Stateless streamable-HTTP MCP: one server + transport per request. */
export async function mcpFetch(
  x402: x402ResourceServer,
  treasury: { network: Network; payTo: string }[],
  tools: Record<string, Tool>,
) {
  await x402.initialize();
  const paid: Record<string, MCPToolCallback<Args>> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const accepts = (
      await Promise.all(
        treasury.map((t) =>
          x402.buildPaymentRequirements({
            scheme: 'exact',
            price: tool.price,
            ...t,
          }),
        ),
      )
    ).flat();
    paid[name] = createPaymentWrapper(x402, {
      accepts,
      resource: {
        url: `mcp://tool/${name}`,
        description: `clankerbanker ${name} (${tool.price}): ${tool.description}`,
        mimeType: 'text/plain',
      },
    })(async (args: Args, ctx) => {
      const out = await tool.run(
        args,
        JSON.stringify(ctx.meta?.[MCP_PAYMENT_META_KEY] ?? ''),
      );
      return typeof out === 'string' ? text(out) : text(out.error, true);
    });
  }
  const list = Object.entries(tools).map(([name, t]) => ({
    name,
    description: `${t.description} (${t.price} USDC per call, x402)`,
    inputSchema: t.input ?? { type: 'object', properties: {} },
  }));
  return async (req: Request) => {
    const server = new Server(
      { name: 'clankerbanker', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: list,
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const tool = tools[params.name];
      const call = paid[params.name];
      if (!tool || !call) return text(`unknown tool ${params.name}`, true);
      const args = params.arguments ?? {};
      const refusal = tool.guard?.(args);
      if (refusal) return text(refusal, true);
      return call(args, { _meta: params._meta });
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
