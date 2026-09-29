/**
 * The kthx MCP bridge against a stateless streamable-HTTP double of the
 * engine's endpoint. Fetches are real; only the timer that reconnects and
 * lists again runs on a FakeClock.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { tmpdir } from 'node:os';
import {
  AgentHarness,
  type AgentHarnessToolInvocation,
  BACKGROUND_CONTEXT,
  type ExecutionEnv,
  MemorySessionRepo,
  withAbortSignal,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  validateToolArguments,
} from '@earendil-works/pi-ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  type BridgedTool,
  KTHX_TOOL_PREFIX,
  type McpBridge,
} from '../src/brain-inputs.ts';
import {
  createKthxMcp,
  MAX_RESULT_CHARS,
  MCP_CALL_TIMEOUT_MS,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_RETRY_MS,
  UNREACHABLE,
} from '../src/mcp.ts';
import {
  eventually,
  FakeMcp,
  type FakeTool,
  RecordingMcpInstruments,
} from './fake-mcp.ts';
import { FakeClock, RecordingLog } from './support.ts';

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
  const bridge = createKthxMcp({
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
  return bridged.execute(
    'call-1',
    args,
    () => {},
    { env: {} as ExecutionEnv },
    {} as AgentHarnessToolInvocation,
    context,
  );
}

function text(result: { content: { type: string; text?: string }[] }) {
  return result.content.map((c) => c.text ?? '').join('');
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

async function failure(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error('the call did not fail');
  return error.message;
}

async function harnessWith(tools: readonly BridgedTool[]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const session = await new MemorySessionRepo().create(
    { id: `mcp-${Math.random().toString(36).slice(2)}` },
    BACKGROUND_CONTEXT,
  );
  const { harness } = await AgentHarness.create(
    {
      session,
      models,
      model: faux.getModel(),
      tools: [...tools],
      toolContext: { env: new NodeExecutionEnv({ cwd: tmpdir() }) },
      systemPrompt: 'test',
    },
    BACKGROUND_CONTEXT,
  );
  return { faux, harness };
}

describe('createKthxMcp', () => {
  test.each([
    ['JSON', false],
    ['SSE', true],
  ])(
    'lists every tool prefixed, never replayed, with schemas pi validates (%s responses)',
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
        expect(t.replay).toBe('never');
      }
      const deploy = named(r.bridge, 'kthx_deployApp');
      expect(deploy.label).toBe('kthx deployApp');
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

    const { faux, harness } = await harnessWith(r.bridge.tools());
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('kthx_echo', { app: 'wishin' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(fauxToolCall('kthx_explode', { app: 'wishin' }), {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('done'),
    ]);
    const ended: { name: string; isError: boolean; text: string }[] = [];
    harness.events.on('tool_end', (event) => {
      ended.push({
        name: event.toolName,
        isError: event.isError,
        text: text(event.result),
      });
    });
    const lane = await harness.lane('main', BACKGROUND_CONTEXT);
    await lane.prompt('ship it', undefined, BACKGROUND_CONTEXT);
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
    await expect(run(echo, { app: 'a' })).rejects.toThrow(UNREACHABLE);
    await eventually(() => r.metrics.up.length === 3, 'the reconnect');
    expect(r.bridge.tools().map((t) => t.name)).toEqual(['kthx_echo']);
    await expect(run(echo, { app: 'a' })).rejects.toThrow(UNREACHABLE);
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
    expect(only!.label).toBe(`kthx ${odd}`);
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
    const byLabel = () =>
      new Map(r.bridge.tools().map((t) => [t.label, t.name]));
    const first = byLabel();

    expect(first.size).toBe(5);
    expect(new Set(first.values()).size).toBe(5);
    expect(first.get('kthx app_deploy')).toBe('kthx_app_deploy');
    for (const name of first.values()) {
      expect(name).toMatch(/^kthx_[A-Za-z0-9_-]{1,59}$/);
    }
    expect(first.get('kthx app.deploy')).toMatch(
      /^kthx_app_deploy_[0-9a-f]{6}$/,
    );
    expect(first.get(`kthx ${long}a`)).toHaveLength(64);
    expect(first.get(`kthx ${long}b`)).toHaveLength(64);
    expect(r.log.of('kthx MCP tool renamed')).toHaveLength(4);

    server.tools = [...names.map((n) => tool(n)).reverse(), tool('app/deploy')];
    await relist(r);
    const second = byLabel();
    for (const [label, name] of first) expect(second.get(label)).toBe(name);
    expect(new Set(second.values()).size).toBe(6);

    const reversed = serve(
      new FakeMcp({ tools: names.map((n) => tool(n)).reverse() }),
    );
    const other = rig(reversed);
    await listed(other);
    expect(new Map(other.bridge.tools().map((t) => [t.label, t.name]))).toEqual(
      first,
    );

    const alone = rig(serve(new FakeMcp({ tools: [tool('app.deploy')] })));
    await listed(alone);
    expect(alone.bridge.tools().map((t) => t.name)).toEqual([
      first.get('kthx app.deploy')!,
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
    const bad = createKthxMcp({
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
