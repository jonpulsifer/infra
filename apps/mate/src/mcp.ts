/**
 * A streamable-HTTP MCP server's tools, bridged into the brain as pi tools
 * under the server's prefix, such as `kthx_*`. A server that takes a token
 * gets it from mate, which holds it. `combineMcp` joins several bridges into
 * the one the brain sees. Each tool set is sticky: a listing only adds or
 * replaces tools, and a tool whose server is down answers an error instead of
 * leaving the set.
 */
import { createHash } from 'node:crypto';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from '@earendil-works/pi-ai';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  McpError,
  type Tool as McpTool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  BridgedTool,
  CreateMcpBridge,
  McpBridge,
  McpBridgeOptions,
} from './brain-inputs.ts';
import { type Clock, type Handle, systemClock } from './clock.ts';
import { plain } from './log.ts';
import { redact } from './redact.ts';

export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 120_000;
export const MCP_RETRY_MS = 60_000;
export const unreachable = (name: string) => `${name} is unreachable`;
/** A result past this many characters is cut, as pi's own tools cut theirs. */
export const MAX_RESULT_CHARS = 50 * 1024;
/** pi's providers take tool names of at most 64 characters. */
const MAX_NAME = 64;
/** `_` and six hex characters of the MCP name's SHA-256. */
const SUFFIX = 7;

type CallResult = Awaited<ReturnType<Client['callTool']>>;

interface Listed {
  readonly signature: string;
  readonly tool: BridgedTool;
}

interface Connection {
  readonly client: Client;
  /** Requests sent on this client that have not settled. */
  inflight: number;
  retired: boolean;
  checking: Promise<void> | null;
}

/** What a failed request says about the server. */
type Failure = 'answered' | 'unclear' | 'down';

export const createMcpBridge: CreateMcpBridge = (options) =>
  new ServerBridge(options);

class ServerBridge implements McpBridge {
  private readonly clock: Clock;
  private readonly listed = new Map<string, Listed>();
  private readonly names = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly waiters = new Set<(up: boolean) => void>();
  private readonly open = new Set<Connection>();
  private current: Connection | null = null;
  private connecting: Promise<void> | null = null;
  private timer: Handle | null = null;
  private started = false;
  private closed = false;
  private everListed = false;

  constructor(private readonly options: McpBridgeOptions) {
    this.clock = options.clock ?? systemClock;
  }

  tools(): readonly BridgedTool[] {
    return [...this.listed.values()].map((entry) => entry.tool);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.connect();
  }

  ready(timeoutMs: number): Promise<boolean> {
    if (this.everListed) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (up: boolean) => {
        this.clock.cancel(timer);
        this.waiters.delete(done);
        resolve(up);
      };
      const timer = this.clock.after(timeoutMs, () => done(false));
      this.waiters.add(done);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) this.clock.cancel(this.timer);
    this.timer = null;
    for (const done of [...this.waiters]) done(false);
    this.current = null;
    await Promise.all([...this.open].map((c) => this.shut(c)));
  }

  private connect(): Promise<void> {
    if (this.closed || this.current) return Promise.resolve();
    this.connecting ??= this.attempt().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async attempt(): Promise<void> {
    const { name, url, token, log, metrics } = this.options;
    const client = new Client({ name: 'mate', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: token
            ? { headers: { Authorization: `Bearer ${token}` } }
            : {},
        }),
        { timeout: MCP_CONNECT_TIMEOUT_MS },
      );
      const tools = await listAll(client);
      if (this.closed) {
        await client.close();
        return;
      }
      const connection: Connection = {
        client,
        inflight: 0,
        retired: false,
        checking: null,
      };
      this.open.add(connection);
      this.current = connection;
      this.merge(tools);
      metrics?.mcpUp(name, true);
      log.info(`${name} MCP listed`, { tools: tools.length });
      this.everListed = true;
      for (const done of [...this.waiters]) done(true);
    } catch (error) {
      await client.close().catch(() => {});
      if (this.closed) return;
      metrics?.mcpUp(name, false);
      log.warn(`${name} MCP unreachable`, {
        error: redact(plain(error)),
        retryMs: MCP_RETRY_MS,
      });
    }
    this.schedule();
  }

  // While up, each tick lists again, so a command the server ships after boot reaches
  // the brain and a server that dies between calls shows as down. While down,
  // each tick reconnects.
  private schedule(): void {
    if (this.closed || this.timer) return;
    this.timer = this.clock.after(MCP_RETRY_MS, () => {
      this.timer = null;
      void (this.current ? this.check(this.current) : this.connect());
    });
  }

  private check(connection: Connection): Promise<void> {
    if (this.current !== connection) return Promise.resolve();
    connection.checking ??= this.relist(connection).finally(() => {
      connection.checking = null;
    });
    return connection.checking;
  }

  private async relist(connection: Connection): Promise<void> {
    try {
      const tools = await this.using(connection, listAll);
      if (this.current !== connection) return;
      this.merge(tools);
      this.options.metrics?.mcpUp(this.options.name, true);
    } catch (error) {
      this.down(connection, error);
    }
    this.schedule();
  }

  private async using<T>(
    connection: Connection,
    work: (client: Client) => Promise<T>,
  ): Promise<T> {
    connection.inflight += 1;
    try {
      return await work(connection.client);
    } finally {
      connection.inflight -= 1;
      if (connection.retired && connection.inflight === 0) {
        void this.shut(connection);
      }
    }
  }

  // Closing a client rejects every request still on it, while the stateless
  // server runs them to the end. A retired client holds no session, so it
  // closes only once its last request settles.
  private down(connection: Connection, error: unknown): void {
    if (this.current !== connection) return;
    this.current = null;
    connection.retired = true;
    if (connection.inflight === 0) void this.shut(connection);
    this.options.metrics?.mcpUp(this.options.name, false);
    this.options.log.warn(`${this.options.name} MCP connection lost`, {
      error: redact(plain(error)),
    });
    void this.connect();
  }

  private async shut(connection: Connection): Promise<void> {
    if (!this.open.delete(connection)) return;
    await connection.client.close().catch(() => {});
  }

  private merge(tools: readonly McpTool[]): void {
    let changed = false;
    for (const tool of namingOrder(tools, this.options.prefix)) {
      const name = this.nameFor(tool.name);
      const signature = JSON.stringify([tool.description, tool.inputSchema]);
      if (this.listed.get(name)?.signature === signature) continue;
      const bridged = this.bridge(tool, name);
      const problem = compileProblem(bridged);
      if (problem) {
        this.options.log.warn(`${this.options.name} MCP tool dropped`, {
          tool: tool.name,
          error: problem,
        });
        continue;
      }
      this.listed.set(name, { signature, tool: bridged });
      changed = true;
    }
    if (!changed) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.options.log.error(`${this.options.name} MCP listener failed`, {
          error: plain(error),
        });
      }
    }
  }

  // A name the prefix alone makes valid keeps it. Any other carries a hash of
  // its MCP name, so it never depends on what else the server lists. Once
  // given, a name never moves to another tool, because pi throws on a
  // duplicate name and a saved run names its tools.
  private nameFor(mcpName: string): string {
    const known = this.names.get(mcpName);
    if (known) return known;
    const { prefix } = this.options;
    const base = piName(prefix, mcpName);
    let n = 0;
    let name =
      base === `${prefix}${mcpName}` ? base : suffixed(base, mcpName, n++);
    while (this.owners.has(name)) name = suffixed(base, mcpName, n++);
    if (name !== base) {
      this.options.log.warn(`${this.options.name} MCP tool renamed`, {
        tool: mcpName,
        name,
        taken: this.owners.get(base),
      });
    }
    this.names.set(mcpName, name);
    this.owners.set(name, mcpName);
    return name;
  }

  private bridge(tool: McpTool, name: string): BridgedTool {
    return {
      name,
      label: `${this.options.name} ${tool.name}`,
      description:
        tool.description ?? `The ${this.options.name} ${tool.name} tool.`,
      parameters: tool.inputSchema as unknown as TSchema,
      replay: 'never',
      execute: (_id, params, _onUpdate, _toolContext, _invocation, context) =>
        this.call(tool.name, params as Record<string, unknown>, context),
    };
  }

  private async call(
    name: string,
    args: Record<string, unknown>,
    { abortSignal: signal }: { abortSignal: AbortSignal | undefined },
  ): Promise<AgentToolResult<unknown>> {
    const { name: server, metrics } = this.options;
    const connection = this.current;
    if (!connection) {
      metrics?.mcpCall(server, 'unavailable');
      throw new Error(unreachable(server));
    }
    let result: CallResult;
    try {
      result = await this.using(connection, (client) =>
        client.callTool({ name, arguments: args }, undefined, {
          signal,
          timeout: MCP_CALL_TIMEOUT_MS,
        }),
      );
    } catch (error) {
      if (signal?.aborted) {
        metrics?.mcpCall(server, 'aborted');
        throw new Error(`${server} ${name} was cancelled`);
      }
      const failure = classify(error);
      if (failure === 'down') {
        metrics?.mcpCall(server, 'unavailable');
        this.down(connection, error);
        throw new Error(`${unreachable(server)}: ${redact(plain(error))}`);
      }
      metrics?.mcpCall(server, 'error');
      if (failure === 'unclear') void this.check(connection);
      throw new Error(redact(plain(error)));
    }
    const text = bounded(server, resultText(result));
    if (result.isError) {
      metrics?.mcpCall(server, 'error');
      throw new Error(text || `${server} ${name} failed`);
    }
    metrics?.mcpCall(server, 'ok');
    return { content: [{ type: 'text', text }], details: undefined };
  }
}

async function listAll(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: MCP_CONNECT_TIMEOUT_MS,
    });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function piName(prefix: string, mcpName: string): string {
  return `${prefix}${mcpName}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, MAX_NAME);
}

function suffixed(base: string, mcpName: string, n: number): string {
  const hex = createHash('sha256')
    .update(n === 0 ? mcpName : `${mcpName}#${n}`)
    .digest('hex');
  return `${base.slice(0, MAX_NAME - SUFFIX)}_${hex.slice(0, SUFFIX - 1)}`;
}

// A name that needs no sanitizing keeps it; the rest go in code-point order,
// so a hash collision resolves the same way whatever order the server lists in.
function namingOrder(tools: readonly McpTool[], prefix: string): McpTool[] {
  const rank = (tool: McpTool) =>
    piName(prefix, tool.name) === `${prefix}${tool.name}` ? 0 : 1;
  return [...tools].sort(
    (a, b) =>
      rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

// A schema pi cannot compile would fail every call, so it never reaches the
// model. An empty call that merely fails validation proves the schema compiles.
function compileProblem(tool: BridgedTool): string | null {
  try {
    validateToolArguments(tool, {
      type: 'toolCall',
      id: 'schema-check',
      name: tool.name,
      arguments: {},
    });
    return null;
  } catch (error) {
    const message = plain(error);
    return message.startsWith('Validation failed for tool') ? null : message;
  }
}

// Only a fetch that never reached the server, a refused token or a closed
// client means the server is down. Another HTTP error or a timeout may be one
// command failing (spindrift answers a command that throws with a 500), so a
// listing decides.
function classify(error: unknown): Failure {
  if (error instanceof McpError) {
    if (error.code === ErrorCode.ConnectionClosed) return 'down';
    return error.code === ErrorCode.RequestTimeout ? 'unclear' : 'answered';
  }
  if (error instanceof TypeError) return 'down';
  if (
    error instanceof StreamableHTTPError &&
    (error.code === 401 || error.code === 403)
  ) {
    return 'down';
  }
  return 'unclear';
}

function resultText(result: CallResult): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    return JSON.stringify(
      'toolResult' in result ? result.toolResult : result,
      null,
      2,
    );
  }
  const parts = result.content.map((block) => {
    switch (block.type) {
      case 'text':
        return block.text;
      case 'resource':
        return 'text' in block.resource
          ? block.resource.text
          : `[resource ${block.resource.uri}]`;
      case 'resource_link':
        return `[resource ${block.uri}]`;
      default:
        return `[${block.type} ${block.mimeType}]`;
    }
  });
  if (parts.length === 0 && result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return parts.join('\n');
}

function bounded(server: string, text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[${server} output cut to ${MAX_RESULT_CHARS} of ${text.length} characters]`;
}

/**
 * One bridge over many. A listing on any server reaches the listener. `ready`
 * waits for every server at once, so it never takes longer than `timeoutMs`,
 * and is true only when all have listed.
 */
export function combineMcp(bridges: readonly McpBridge[]): McpBridge {
  return {
    tools: () => bridges.flatMap((b) => b.tools()),
    onChange(listener) {
      const offs = bridges.map((b) => b.onChange(listener));
      return () => {
        for (const off of offs) off();
      };
    },
    start() {
      for (const b of bridges) b.start();
    },
    async ready(timeoutMs) {
      const results = await Promise.all(bridges.map((b) => b.ready(timeoutMs)));
      return results.every(Boolean);
    },
    async close() {
      await Promise.all(bridges.map((b) => b.close()));
    },
  };
}
