/**
 * A kthx MCP server double, stateless like `apps/spindrift/src/web/mcp-route.ts`:
 * one JSON-RPC request per POST, answered as JSON or, in `sse` mode, as one
 * event on a `text/event-stream`.
 */
import type { McpInstruments } from '../src/brain-inputs.ts';

export interface FakeTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface FakeResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export type FakeHandler = (
  args: Record<string, unknown>,
) => FakeResult | Promise<FakeResult>;

export interface Recorded {
  method: string;
  authorization: string | null;
  params: Record<string, unknown> | undefined;
}

interface Rpc {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export class FakeMcp {
  tools: FakeTool[];
  readonly handlers = new Map<string, FakeHandler>();
  /** Answers every POST with this HTTP status and a JSON-RPC error, as spindrift does a bad bearer. */
  status: number | null = null;
  readonly requests: Recorded[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port = 0;

  constructor(
    private readonly options: {
      tools?: FakeTool[];
      sse?: boolean;
      pageSize?: number;
    } = {},
  ) {
    this.tools = options.tools ?? [];
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  start(): this {
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: this.port,
      fetch: (request) => this.handle(request),
    });
    this.port = this.server.port ?? 0;
    return this;
  }

  /** Drops every open connection unless `graceful`, which lets requests in flight finish. */
  async stop(graceful = false): Promise<void> {
    const server = this.server;
    this.server = null;
    if (graceful) void server?.stop(false);
    else await server?.stop(true);
  }

  calls(method: string): Recorded[] {
    return this.requests.filter((r) => r.method === method);
  }

  private async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('POST JSON-RPC here\n', { status: 405 });
    }
    const rpc = (await request.json()) as Rpc;
    this.requests.push({
      method: rpc.method ?? '',
      authorization: request.headers.get('authorization'),
      params: rpc.params,
    });
    if (this.status !== null) {
      return Response.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'no' },
        },
        { status: this.status },
      );
    }
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    try {
      return this.reply(rpc.id, await this.answer(rpc));
    } catch {
      // spindrift's route has no catch around a command, so Bun answers a
      // command that throws with a bare 500.
      return new Response('Internal Server Error', { status: 500 });
    }
  }

  private async answer(
    rpc: Rpc,
  ): Promise<{ result?: unknown; error?: unknown }> {
    switch (rpc.method) {
      case 'initialize':
        return {
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-kthx', version: '1' },
          },
        };
      case 'tools/list':
        return { result: this.page(rpc.params?.cursor) };
      case 'tools/call': {
        const name = String(rpc.params?.name ?? '');
        const handler = this.handlers.get(name);
        if (!handler) {
          return { error: { code: -32602, message: `unknown tool ${name}` } };
        }
        const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
        return { result: await handler(args) };
      }
      default:
        return {
          error: { code: -32601, message: `unknown method ${rpc.method}` },
        };
    }
  }

  private page(cursor: unknown): { tools: FakeTool[]; nextCursor?: string } {
    const size = this.options.pageSize;
    if (!size) return { tools: this.tools };
    const start = Number(cursor ?? 0);
    const end = start + size;
    return {
      tools: this.tools.slice(start, end),
      ...(end < this.tools.length ? { nextCursor: String(end) } : {}),
    };
  }

  private reply(
    id: string | number,
    body: { result?: unknown; error?: unknown },
  ): Response {
    const message = { jsonrpc: '2.0', id, ...body };
    if (!this.options.sse) return Response.json(message);
    return new Response(
      `event: message\ndata: ${JSON.stringify(message)}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
}

export class RecordingMcpInstruments implements McpInstruments {
  readonly up: boolean[] = [];
  readonly calls: string[] = [];
  mcpUp(up: boolean): void {
    this.up.push(up);
  }
  mcpCall(result: 'ok' | 'error' | 'unavailable' | 'aborted'): void {
    this.calls.push(result);
  }
}

/** Polls in real time: the bridge's fetches run on the real event loop even under a FakeClock. */
export async function eventually(
  check: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
