/**
 * The kthx MCP bridge against a stateless streamable-HTTP double of the
 * engine's endpoint. Fetches are real; only the timer that reconnects and
 * lists again runs on a FakeClock.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from '@earendil-works/chord/context';
import { createModels, validateToolArguments } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  type ToolExecutionApi,
  type ToolExecutionResult,
} from '@earendil-works/pi-durable';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type BridgedTool,
  KTHX_TOOL_PREFIX,
  type McpBridge,
} from '../src/brain-inputs.ts';
import {
  combineMcp,
  createMcpBridge,
  MAX_RESULT_CHARS,
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_RETRY_MS,
  unreachable,
} from '../src/mcp.ts';
import {
  eventually,
  FakeMcp,
  type FakeTool,
  RecordingMcpInstruments,
} from './fake-mcp.ts';
import { FakeClock, RecordingLog } from './support.ts';

const UNREACHABLE = unreachable('kthx');
const TOKEN = 'kthx_agent_0123456789abcdef0123456789abcdef';

const APP_SCHEMA = {
  type: 'object',
  properties: { app: { type: 'string', description: 'The app' } },
  required: ['app'],
};

function tool(name: string, extra: Partial<FakeTool> = {}): FakeTool {
  return {
    name,
    description: `The ${name} command`,
    inputSchema: APP_SCHEMA,
    ...extra,
  };
}

interface Rig {
  server: FakeMcp;
  bridge: McpBridge;
  clock: FakeClock;
  log: RecordingLog;
  metrics: RecordingMcpInstruments;
}

const servers: FakeMcp[] = [];
const bridges: McpBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function serve(server: FakeMcp): FakeMcp {
  servers.push(server);
  return server.start();
}

function rig(server: FakeMcp): Rig {
  const clock = new FakeClock();
  const log = new RecordingLog();
  const metrics = new RecordingMcpInstruments();
  const bridge = createMcpBridge({
    name: 'kthx',
    prefix: KTHX_TOOL_PREFIX,
    url: server.url,
    token: TOKEN,
    log,
    clock,
    metrics,
  });
  bridges.push(bridge);
  return { server, bridge, clock, log, metrics };
}

async function listed(r: Rig): Promise<void> {
  r.bridge.start();
  expect(await r.bridge.ready(MCP_CONNECT_TIMEOUT_MS)).toBe(true);
}

function named(bridge: McpBridge, name: string): BridgedTool {
  const found = bridge.tools().find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function run(
  bridged: BridgedTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const context = signal
    ? withAbortSignal(signal, BACKGROUND_CONTEXT)
    : BACKGROUND_CONTEXT;
  return bridged.execute(args, {} as ToolExecutionApi, context);
}

function text(result: Pick<ToolExecutionResult, 'content'>) {
  return (result.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('');
}

// The MCP tool a bridged tool calls, seen by the server.
async function target(server: FakeMcp, bridged: BridgedTool): Promise<string> {
  const before = server.calls('tools/call').length;
  await run(bridged, {});
  return String(server.calls('tools/call')[before]?.params?.name);
}

async function targets(
  server: FakeMcp,
  bridge: McpBridge,
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const bridged of bridge.tools()) {
    found.set(await target(server, bridged), bridged.name);
  }
  return found;
}

// Lets the timer list again, and waits for that listing to land.
async function relist(r: Rig): Promise<void> {
  const ups = r.metrics.up.length;
  await r.clock.advance(MCP_RETRY_MS);
  await eventually(() => r.metrics.up.length > ups, 'the relisting');
}

// Answers once `release` is called, as a deploy that takes a while does.
function slowly(server: FakeMcp, name: string): () => void {
  let release = () => {};
  server.handlers.set(
    name,
    () =>
      new Promise((resolve) => {
        release = () => resolve({ content: [{ type: 'text', text: 'late' }] });
      }),
  );
  return () => release();
}

async function failure(call: Promise<ToolExecutionResult>): Promise<string> {
  const result = await call;
  if (!result.isError) throw new Error('the call did not fail');
  return text(result);
}

async function harnessWith(tools: readonly BridgedTool[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'mcp', tools: [...tools] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  const { provider, id } = faux.getModel();
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider, modelId: id } },
  });
  return { faux, harness, root };
}

describe('createMcpBridge', () => {
  test.each([
    ['JSON', false],
    ['SSE', true],
  ])(
    'lists every tool prefixed, never replayed after a crash, with schemas pi validates (%s responses)',
    async (_mode, sse) => {
      const server = serve(
        new FakeMcp({
          sse,
          pageSize: 1,
          tools: [
            tool('listApps', { inputSchema: { type: 'object' } }),
            tool('deployApp'),
          ],
        }),
      );
      const r = rig(server);
      await listed(r);

      const tools = r.bridge.tools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'kthx_deployApp',
        'kthx_listApps',
      ]);
      for (const t of tools) {
        expect(t.name.startsWith(KTHX_TOOL_PREFIX)).toBe(true);
        expect(t.replay).toBe('unsafe');
      }
      const deploy = named(r.bridge, 'kthx_deployApp');
      expect(deploy.description).toBe('The deployApp command');
      const call = { type: 'toolCall' as const, id: 'c', name: deploy.name };
      expect(
        validateToolArguments(deploy, {
          ...call,
          arguments: { app: 'wishin' },
        }),
      ).toEqual({ app: 'wishin' });
      expect(() =>
        validateToolArguments(deploy, { ...call, arguments: {} }),
      ).toThrow('Validation failed');
      expect(r.metrics.up).toEqual([true]);
    },
  );

  test('sends the agent token as a bearer and never logs it', async () => {
    const server = serve(new FakeMcp({ tools: [tool('listApps')] }));
    server.status = 401;
    const r = rig(server);
    r.bridge.start();
    await eventually(() => r.metrics.up.length === 1, 'the refused attempt');
    server.status = null;
    await r.clock.advance(MCP_RETRY_MS);
    expect(await r.bridge.ready(MCP_CONNECT_TIMEOUT_MS)).toBe(true);

    expect(server.requests.length).toBeGreaterThan(2);
    for (const request of server.requests) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.stringify(r.log.entries)).not.toContain(TOKEN);
  });

  test('a call returns the tool text, and an isError result is a pi error result', async () => {
    const server = serve(
      new FakeMcp({ tools: [tool('echo'), tool('explode')] }),
    );
    server.handlers.set('echo', (args) => ({
      content: [{ type: 'text', text: `deployed ${args.app}` }],
    }));
    server.handlers.set('explode', () => ({
      content: [{ type: 'text', text: 'the build failed' }],
      isError: true,
    }));
    const r = rig(server);
    await listed(r);

    const { faux, harness, root } = await harnessWith(r.bridge.tools());
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('kthx_echo', { app: 'wishin' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxToolCall('kthx_explode', { app: 'wishin' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const submission = await root.submit(
      { type: 'input', content: 'ship it' },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const ended = [...page.items]
      .reverse()
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) =>
        message.role === 'toolResult'
          ? [
              {
                name: message.toolName,
                isError: message.isError,
                text: text(message),
              },
            ]
          : [],
      );
    await harness.close(BACKGROUND_CONTEXT);

    expect(ended).toEqual([
      { name: 'kthx_echo', isError: false, text: 'deployed wishin' },
      { name: 'kthx_explode', isError: true, text: 'the build failed' },
    ]);
    expect(server.calls('tools/call').map((c) => c.params?.name)).toEqual([
      'echo',
      'explode',
    ]);
    expect(r.metrics.calls).toEqual(['ok', 'error']);
  });

  test('a refused listing gives no tools, and the retry lists them', async () => {
    const server = serve(new FakeMcp({ tools: [tool('listApps')] }));
    server.status = 401;
    const r = rig(server);
    r.bridge.start();
    await eventually(() => r.metrics.up.length === 1, 'the refused attempt');
    expect(r.bridge.tools()).toEqual([]);
    expect(r.metrics.up).toEqual([false]);
    expect(r.log.of('kthx MCP unreachable')).toHaveLength(1);

    server.status = null;
    const before = server.requests.length;
    await r.clock.advance(MCP_RETRY_MS - 1);
    expect(server.requests.length).toBe(before);
    await r.clock.advance(1);
    await eventually(() => r.bridge.tools().length === 1, 'the retry');
    expect(r.metrics.up).toEqual([false, true]);
  });

  test('a server that is down gives no tools until it comes up', async () => {
    const server = serve(new FakeMcp({ tools: [tool('listApps')] }));
    await server.stop();
    const r = rig(server);
    r.bridge.start();
    await eventually(() => r.metrics.up.length === 1, 'the failed attempt');
    expect(r.bridge.tools()).toEqual([]);

    server.start();
    await r.clock.advance(MCP_RETRY_MS);
    await eventually(() => r.bridge.tools().length === 1, 'the retry');
    expect(r.bridge.tools()[0]!.name).toBe('kthx_listApps');
  });

  test('tools stay listed while the server is down, and a call answers that kthx is unreachable', async () => {
    const server = serve(new FakeMcp({ tools: [tool('echo')] }));
    server.handlers.set('echo', () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    const r = rig(server);
    await listed(r);
    const echo = named(r.bridge, 'kthx_echo');

    await server.stop();
    expect(await failure(run(echo, { app: 'a' }))).toContain(UNREACHABLE);
    await eventually(() => r.metrics.up.length === 3, 'the reconnect');
    expect(r.bridge.tools().map((t) => t.name)).toEqual(['kthx_echo']);
    expect(await failure(run(echo, { app: 'a' }))).toContain(UNREACHABLE);
    expect(r.metrics.calls).toEqual(['unavailable', 'unavailable']);
    expect(r.metrics.up).toEqual([true, false, false]);

    server.start();
    await r.clock.advance(MCP_RETRY_MS);
    await eventually(() => r.metrics.up.at(-1) === true, 'the retry');
    expect(text(await run(echo, { app: 'a' }))).toBe('pong');
    expect(r.bridge.tools()).toEqual([echo]);
  });

  test('an abort cancels the call at once and tells the server', async () => {
    const server = serve(new FakeMcp({ tools: [tool('slow')] }));
    const release = slowly(server, 'slow');
    const r = rig(server);
    await listed(r);

    try {
      const controller = new AbortController();
      const call = run(named(r.bridge, 'kthx_slow'), {}, controller.signal);
      await eventually(
        () => server.calls('tools/call').length === 1,
        'the call to arrive',
      );
      const started = Date.now();
      controller.abort();
      await expect(call).rejects.toThrow('cancelled');
      expect(Date.now() - started).toBeLessThan(1_000);
      await eventually(
        () => server.calls('notifications/cancelled').length === 1,
        'the cancel notice',
      );
      expect(r.metrics.calls).toEqual(['aborted']);
    } finally {
      release();
    }
  });

  test('a call the server fails with an HTTP error leaves a sibling call in flight to finish', async () => {
    const server = serve(new FakeMcp({ tools: [tool('slow'), tool('boom')] }));
    const release = slowly(server, 'slow');
    server.handlers.set('boom', () => {
      throw new Error('the command threw');
    });
    const r = rig(server);
    await listed(r);

    try {
      const slow = run(named(r.bridge, 'kthx_slow'), {});
      await eventually(
        () => server.calls('tools/call').length === 1,
        'the slow call to arrive',
      );
      const message = await failure(run(named(r.bridge, 'kthx_boom'), {}));
      expect(message).toContain('Internal Server Error');
      expect(message).not.toContain(UNREACHABLE);
      await eventually(
        () => r.metrics.up.length === 2,
        'the listing that checks the server',
      );
      release();
      expect(text(await slow)).toBe('late');
      expect(r.metrics.calls).toEqual(['error', 'ok']);
      expect(r.metrics.up).toEqual([true, true]);
      expect(r.log.of('kthx MCP connection lost')).toEqual([]);
    } finally {
      release();
    }
  });

  test('a server that goes away fails a new call as unreachable, and a call already running still finishes', async () => {
    const server = serve(new FakeMcp({ tools: [tool('slow'), tool('echo')] }));
    const release = slowly(server, 'slow');
    const r = rig(server);
    await listed(r);

    try {
      const slow = run(named(r.bridge, 'kthx_slow'), {});
      await eventually(
        () => server.calls('tools/call').length === 1,
        'the slow call to arrive',
      );
      await server.stop(true);
      expect(await failure(run(named(r.bridge, 'kthx_echo'), {}))).toContain(
        UNREACHABLE,
      );
      await eventually(() => r.metrics.up.length === 3, 'the reconnect');
      release();
      expect(text(await slow)).toBe('late');
      expect(r.metrics.calls).toEqual(['unavailable', 'ok']);
      expect(r.metrics.up).toEqual([true, false, false]);
    } finally {
      release();
    }
  });

  test('while up it lists again each interval, so a new command appears and a server that dies between calls reads as down', async () => {
    const server = serve(new FakeMcp({ tools: [tool('listApps')] }));
    const r = rig(server);
    let changes = 0;
    r.bridge.onChange(() => {
      changes += 1;
    });
    await listed(r);

    server.tools = [tool('listApps'), tool('deployApp')];
    await relist(r);
    expect(r.bridge.tools().map((t) => t.name)).toEqual([
      'kthx_listApps',
      'kthx_deployApp',
    ]);
    expect(changes).toBe(2);
    expect(r.metrics.up).toEqual([true, true]);

    await server.stop();
    await r.clock.advance(MCP_RETRY_MS);
    await eventually(() => r.metrics.up.at(-1) === false, 'the failed listing');
    expect(r.log.of('kthx MCP connection lost')).toHaveLength(1);
    expect(r.bridge.tools()).toHaveLength(2);
  });

  test('a long result is cut with a note', async () => {
    const server = serve(new FakeMcp({ tools: [tool('logs')] }));
    const long = 'x'.repeat(MAX_RESULT_CHARS + 10);
    server.handlers.set('logs', () => ({
      content: [{ type: 'text', text: long }],
    }));
    const r = rig(server);
    await listed(r);

    const out = text(await run(named(r.bridge, 'kthx_logs'), {}));
    expect(out).toBe(
      `${long.slice(0, MAX_RESULT_CHARS)}\n[kthx output cut to ${MAX_RESULT_CHARS} of ${long.length} characters]`,
    );
  });

  test('a long multi-line result reaches the model cut once, by the bridge', async () => {
    const server = serve(new FakeMcp({ tools: [tool('logs')] }));
    const lines = Array.from({ length: 5_000 }, () => 'x'.repeat(20)).join(
      '\n',
    );
    server.handlers.set('logs', () => ({
      content: [{ type: 'text', text: lines }],
    }));
    const r = rig(server);
    await listed(r);
    const { faux, harness, root } = await harnessWith(r.bridge.tools());
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('kthx_logs', { app: 'a' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const submission = await root.submit(
      { type: 'input', content: 'logs' },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
    const page = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const [result] = page.items
      .flatMap((entry) => entry.model ?? [])
      .flatMap((message) => (message.role === 'toolResult' ? [message] : []));
    await harness.close(BACKGROUND_CONTEXT);

    expect(text(result!)).toBe(
      `${lines.slice(0, MAX_RESULT_CHARS)}\n[kthx output cut to ${MAX_RESULT_CHARS} of ${lines.length} characters]`,
    );
  });

  test('a call waits for the bridge timeout, not the SDK default', async () => {
    const server = serve(new FakeMcp({ tools: [tool('echo')] }));
    server.handlers.set('echo', () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    const r = rig(server);
    await listed(r);
    const callTool = spyOn(Client.prototype, 'callTool');

    try {
      expect(text(await run(named(r.bridge, 'kthx_echo'), {}))).toBe('pong');
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(callTool.mock.calls[0]![2]).toMatchObject({
        timeout: MCP_CALL_TIMEOUT_MS,
      });
    } finally {
      callTool.mockRestore();
    }
  });

  test('a tool whose schema pi cannot compile is dropped with a log', async () => {
    const server = serve(
      new FakeMcp({
        tools: [
          tool('good'),
          tool('broken', {
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string', pattern: '([' } },
            },
          }),
        ],
      }),
    );
    const r = rig(server);
    await listed(r);

    expect(r.bridge.tools().map((t) => t.name)).toEqual(['kthx_good']);
    const dropped = r.log.of('kthx MCP tool dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.fields?.tool).toBe('broken');
  });

  test('a long or odd name is cut to 64 safe characters', async () => {
    const odd = `site.deploy/with spaces:${'x'.repeat(80)}`;
    const server = serve(new FakeMcp({ tools: [tool(odd)] }));
    const r = rig(server);
    await listed(r);

    const [only] = r.bridge.tools();
    expect(only!.name).toMatch(/^kthx_[A-Za-z0-9_-]+$/);
    expect(only!.name).toHaveLength(64);
    expect(only!.name.startsWith('kthx_site_deploy_with_spaces_xxx')).toBe(
      true,
    );
    expect(await targets(server, r.bridge)).toEqual(
      new Map([[odd, only!.name]]),
    );
  });

  test('names that sanitize alike stay distinct, and keep their names across listings and tool sets', async () => {
    const long = 'y'.repeat(70);
    const names = [
      'app.deploy',
      'app deploy',
      'app_deploy',
      `${long}a`,
      `${long}b`,
    ];
    const server = serve(new FakeMcp({ tools: names.map((n) => tool(n)) }));
    const r = rig(server);
    await listed(r);
    const first = await targets(server, r.bridge);

    expect(first.size).toBe(5);
    expect(new Set(first.values()).size).toBe(5);
    expect(first.get('app_deploy')).toBe('kthx_app_deploy');
    for (const name of first.values()) {
      expect(name).toMatch(/^kthx_[A-Za-z0-9_-]{1,59}$/);
    }
    expect(first.get('app.deploy')).toMatch(/^kthx_app_deploy_[0-9a-f]{6}$/);
    expect(first.get(`${long}a`)).toHaveLength(64);
    expect(first.get(`${long}b`)).toHaveLength(64);
    expect(r.log.of('kthx MCP tool renamed')).toHaveLength(4);

    server.tools = [...names.map((n) => tool(n)).reverse(), tool('app/deploy')];
    await relist(r);
    const second = await targets(server, r.bridge);
    for (const [mcpName, name] of first) {
      expect(second.get(mcpName)).toBe(name);
    }
    expect(new Set(second.values()).size).toBe(6);

    const reversed = serve(
      new FakeMcp({ tools: names.map((n) => tool(n)).reverse() }),
    );
    const other = rig(reversed);
    await listed(other);
    expect(await targets(reversed, other.bridge)).toEqual(first);

    const alone = rig(serve(new FakeMcp({ tools: [tool('app.deploy')] })));
    await listed(alone);
    expect(alone.bridge.tools().map((t) => t.name)).toEqual([
      first.get('app.deploy')!,
    ]);

    const { harness } = await harnessWith(r.bridge.tools());
    await harness.close(BACKGROUND_CONTEXT);
  });

  test('onChange fires when a listing adds or replaces a tool, not when it repeats', async () => {
    const server = serve(new FakeMcp({ tools: [tool('echo')] }));
    const r = rig(server);
    let changes = 0;
    r.bridge.onChange(() => {
      changes += 1;
    });
    await listed(r);
    expect(changes).toBe(1);
    const before = named(r.bridge, 'kthx_echo');

    await relist(r);
    expect(changes).toBe(1);
    expect(named(r.bridge, 'kthx_echo')).toBe(before);

    server.tools = [tool('echo', { description: 'Echoes, louder' })];
    await relist(r);
    expect(changes).toBe(2);
    expect(named(r.bridge, 'kthx_echo').description).toBe('Echoes, louder');
    expect(r.bridge.tools()).toHaveLength(1);
  });

  test('ready is false once its wait runs out, and true after a listing', async () => {
    const server = serve(new FakeMcp({ tools: [tool('echo')] }));
    await server.stop();
    const r = rig(server);
    r.bridge.start();
    const waiting = r.bridge.ready(10_000);
    await eventually(() => r.metrics.up.length === 1, 'the failed attempt');
    await r.clock.advance(10_000);
    expect(await waiting).toBe(false);

    server.start();
    const again = r.bridge.ready(MCP_RETRY_MS * 2);
    await r.clock.advance(MCP_RETRY_MS);
    expect(await again).toBe(true);
    expect(await r.bridge.ready(0)).toBe(true);
  });

  test('start, ready and tools never throw, even for a URL that cannot parse', async () => {
    const r = rig(new FakeMcp());
    const bad = createMcpBridge({
      name: 'kthx',
      prefix: KTHX_TOOL_PREFIX,
      url: 'not a url',
      token: TOKEN,
      log: r.log,
      clock: r.clock,
      metrics: r.metrics,
    });
    bridges.push(bad);
    bad.start();
    bad.start();
    await eventually(() => r.metrics.up.length === 1, 'the failed attempt');
    expect(bad.tools()).toEqual([]);
    const waiting = bad.ready(5);
    await r.clock.advance(5);
    expect(await waiting).toBe(false);
  });
});

describe('several servers', () => {
  function weatherRig(server: FakeMcp, clock: FakeClock, log: RecordingLog) {
    const metrics = new RecordingMcpInstruments();
    const bridge = createMcpBridge({
      name: 'weather',
      prefix: 'weather_',
      url: server.url,
      log,
      clock,
      metrics,
    });
    bridges.push(bridge);
    return { bridge, metrics };
  }

  test('a server with no token sends no Authorization header, under its own prefix', async () => {
    const server = serve(new FakeMcp({ tools: [tool('forecast')] }));
    const { bridge, metrics } = weatherRig(
      server,
      new FakeClock(),
      new RecordingLog(),
    );
    bridge.start();
    expect(await bridge.ready(MCP_CONNECT_TIMEOUT_MS)).toBe(true);

    expect(await targets(server, bridge)).toEqual(
      new Map([['forecast', 'weather_forecast']]),
    );
    expect(server.requests.length).toBeGreaterThan(1);
    for (const request of server.requests) {
      expect(request.authorization).toBeNull();
    }
    expect(metrics.servers).toEqual(new Set(['weather']));
  });

  test('one bridge over kthx and weather lists both prefixes and calls each server', async () => {
    const k = rig(serve(new FakeMcp({ tools: [tool('deploy')] })));
    k.server.handlers.set('deploy', () => ({
      content: [{ type: 'text', text: 'deployed' }],
    }));
    const wServer = serve(new FakeMcp({ tools: [tool('forecast')] }));
    wServer.handlers.set('forecast', () => ({
      content: [{ type: 'text', text: 'sunny' }],
    }));
    const w = weatherRig(wServer, k.clock, k.log);
    const both = combineMcp([k.bridge, w.bridge]);
    let changes = 0;
    both.onChange(() => {
      changes += 1;
    });
    both.start();
    expect(await both.ready(MCP_CONNECT_TIMEOUT_MS)).toBe(true);

    expect(both.tools().map((t) => t.name)).toEqual([
      'kthx_deploy',
      'weather_forecast',
    ]);
    expect(changes).toBe(2);
    expect(text(await run(named(both, 'weather_forecast'), { app: 'a' }))).toBe(
      'sunny',
    );
    expect(text(await run(named(both, 'kthx_deploy'), { app: 'a' }))).toBe(
      'deployed',
    );
    expect(k.server.requests.every((q) => q.authorization !== null)).toBe(true);
    expect(wServer.requests.every((q) => q.authorization === null)).toBe(true);
  });

  test('one server down leaves the other listed and working, and ready waits no longer than the timeout', async () => {
    const down = serve(new FakeMcp({ tools: [tool('deploy')] }));
    await down.stop();
    const k = rig(down);
    const wServer = serve(new FakeMcp({ tools: [tool('forecast')] }));
    wServer.handlers.set('forecast', () => ({
      content: [{ type: 'text', text: 'sunny' }],
    }));
    const w = weatherRig(wServer, k.clock, k.log);
    const both = combineMcp([k.bridge, w.bridge]);
    both.start();
    await eventually(() => k.metrics.up.length === 1, 'the failed attempt');
    const waiting = both.ready(10_000);
    await k.clock.advance(10_000);
    expect(await waiting).toBe(false);

    expect(both.tools().map((t) => t.name)).toEqual(['weather_forecast']);
    expect(text(await run(named(both, 'weather_forecast'), { app: 'a' }))).toBe(
      'sunny',
    );
    expect(k.metrics.up).toEqual([false]);
    expect(w.metrics.up).toEqual([true]);
  });

  test('a call to a server that went down names that server as unreachable', async () => {
    const server = serve(new FakeMcp({ tools: [tool('forecast')] }));
    const w = weatherRig(server, new FakeClock(), new RecordingLog());
    w.bridge.start();
    expect(await w.bridge.ready(MCP_CONNECT_TIMEOUT_MS)).toBe(true);
    await server.stop();
    const message = await failure(
      run(named(w.bridge, 'weather_forecast'), { app: 'a' }),
    );
    expect(message).toContain(unreachable('weather'));
    expect(message).not.toContain(UNREACHABLE);
  });
});
