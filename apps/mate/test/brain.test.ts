/**
 * The brain against Postgres, pi-ai's faux model and hands over a temp
 * directory: turns, Stop, faults, quarantine, durable resume and retention.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentMessage,
  BACKGROUND_CONTEXT,
  type Context,
  laneConfig,
  SessionInvariantError,
  type Storage,
  StorageBackedSession,
  type Value,
  type Write,
} from '@earendil-works/pi-agent-core';
import { StorageDecorator } from '@earendil-works/pi-agent-core/harness/session/testing';
import { createModels } from '@earendil-works/pi-ai';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  openSession,
  POSTGRES_STORAGE_VERSION,
  postgresStorage,
  sessionExists,
} from '@repo/pi-store-postgres';
import { SQL } from 'bun';
import {
  NO_TEXT,
  PiBrain,
  type PiBrainDeps,
  postgresSessions,
  providerErrorKind,
  RECOVERING,
  resetNote,
  type SessionSource,
  unreachableTool,
} from '../src/brain.ts';
import type {
  BridgedTool,
  McpBridge,
  ModelSetup,
} from '../src/brain-inputs.ts';
import { BrainUnavailable, TurnAbandoned } from '../src/brain-port.ts';
import { systemClock } from '../src/clock.ts';
import { silentLog } from '../src/log.ts';
import { LIMIT_FALLBACK } from '../src/notices.ts';
import { CHATGPT_PROVIDER, routeModels } from '../src/route.ts';
import type { PromptSink, Update } from '../src/sandbox.ts';
import { POOL_OPTIONS, PostgresThreadStore } from '../src/store.ts';
import { type ThreadRef, threadKey } from '../src/surface.ts';
import type { ThreadRow } from '../src/thread-store.ts';
import { withDatabase } from './db.ts';
import { LocalHands, type LocalHandsOptions } from './local-hands.ts';
import { stallingProxy } from './stall-proxy.ts';
import { FakeClock, RecordingInstruments, RecordingLog } from './support.ts';

const database = withDatabase();
const ctx = BACKGROUND_CONTEXT;
const ASKER = { asker: 'u1', message: { channelId: 'c1', id: 'm1' } };

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mate-brain-'));
  writeFileSync(join(root, 'notes.txt'), 'the notes\n');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

class Recorder implements PromptSink {
  readonly updates: Update[] = [];
  update(update: Update): void {
    this.updates.push(update);
  }
  get text(): string {
    return this.updates.map((u) => (u.kind === 'text' ? u.delta : '')).join('');
  }
  get cards() {
    return this.updates.flatMap((u) => (u.kind === 'tool' ? [u.call] : []));
  }
}

interface Faux {
  readonly setup: ModelSetup;
  readonly options: { sessionId?: string; model: string }[];
  script(...steps: FauxResponseStep[]): void;
}

function faux(
  modelId = 'faux-new',
  thinking: ModelSetup['thinking'] = 'off',
): Faux {
  const provider = fauxProvider({
    api: 'faux',
    provider: 'faux',
    tokenSize: { min: 3, max: 3 },
    models: [
      { id: 'faux-old', reasoning: true, cost: price },
      { id: 'faux-new', reasoning: true, cost: price },
    ],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const model = provider.getModel(modelId);
  if (!model) throw new Error(`no faux model ${modelId}`);
  const options: Faux['options'] = [];
  const record =
    (step: FauxResponseStep): FauxResponseStep =>
    (context, streamOptions, state, requested) => {
      options.push({
        sessionId: streamOptions?.sessionId,
        model: requested.id,
      });
      return typeof step === 'function'
        ? step(context, streamOptions, state, requested)
        : step;
    };
  return {
    setup: { models, direct: models, model, thinking, router: null },
    options,
    script: (...steps) => provider.setResponses(steps.map(record)),
  };
}

// $1 per million tokens both ways, so a turn's cost is visible.
const price = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

const tool = (
  name: string,
  args: Parameters<typeof fauxToolCall>[1],
  id = `call-${name}`,
) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: 'toolUse',
  });

let serial = 0;
function thread(): ThreadRef {
  serial += 1;
  return {
    surface: 'discord',
    channelId: 'c1',
    id: `brain-${Date.now()}-${serial}`,
  };
}

interface Built {
  brain: PiBrain;
  hands: LocalHands;
  store: PostgresThreadStore;
  log: RecordingLog;
  metrics: RecordingInstruments;
}

function build(
  model: Faux,
  opts: Omit<Partial<PiBrainDeps>, 'hands'> & {
    hands?: LocalHandsOptions | LocalHands;
  } = {},
): Built {
  const { sql } = database();
  const hands =
    opts.hands instanceof LocalHands
      ? opts.hands
      : new LocalHands({ root, ...opts.hands });
  const store = new PostgresThreadStore(sql);
  const log = new RecordingLog();
  const metrics = new RecordingInstruments();
  const brain = new PiBrain({
    db: { up: () => true },
    store,
    sessions: postgresSessions(sql),
    setup: model.setup,
    prompts: { discord: 'You help on Discord.', slack: 'You help on Slack.' },
    mcp: null,
    turnTimeoutMs: 60_000,
    log,
    metrics,
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    ...opts,
    hands,
  });
  return { brain, hands, store, log, metrics };
}

async function opened(built: Built, ref = thread()) {
  const row = await built.store.open(ref);
  const session = await built.brain.open(row);
  return { ref, row, session };
}

async function lane(sessionId: string) {
  const session = await openSession(database().sql, { id: sessionId });
  const config = await session.getValue(laneConfig('main'), ctx);
  await session.close(ctx);
  return config?.value;
}

describe('a turn', () => {
  test('a chat-only turn streams its answer and never leases a sandbox', async () => {
    const model = faux();
    model.script(
      fauxAssistantMessage([fauxThinking('hmm'), fauxText('hello there')]),
    );
    const built = build(model);
    const { session } = await opened(built);
    const sink = new Recorder();
    const result = await built.brain.prompt(session, 'hi', sink, ASKER);
    expect(result.stopReason).toBe('end_turn');
    expect(sink.text).toBe('hello there');
    expect(built.hands.acquisitions).toBe(0);
    expect(built.hands.calls).toEqual([]);
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  test('a tool turn shows its card and the sandbox card, and gives the answer', async () => {
    const model = faux();
    model.script(
      tool('bash', { command: 'cat notes.txt' }),
      fauxAssistantMessage('the notes say hi'),
    );
    const built = build(model, {
      hands: {
        root,
        events: [
          { kind: 'step', step: 'creating' },
          { kind: 'connecting' },
          { kind: 'ready', sandbox: 'mate-x', source: 'fresh' },
        ],
      },
    });
    const { session, row } = await opened(built);
    const sink = new Recorder();
    const result = await built.brain.prompt(session, 'read it', sink, ASKER);
    expect(result.stopReason).toBe('end_turn');
    expect(sink.text).toBe('the notes say hi');
    expect(sink.cards).toContainEqual({
      id: 'call-bash',
      title: '$ cat notes.txt',
      state: 'complete',
    });
    expect(sink.cards.filter((card) => card.id === 'sandbox').at(-1)).toEqual({
      id: 'sandbox',
      title: '🖥️ sandbox ready',
      state: 'complete',
    });
    expect(built.hands.acquisitions).toBe(1);
    expect(built.metrics.tools).toEqual([{ tool: 'bash', isError: false }]);
    // The hooks recorded where the checkout lives.
    await built.brain.release(row.ref, 'quiet');
    expect((await built.store.get(row.key))?.sandbox).toBeNull();
  });

  test('pi sends the session as `key:main`, which the provider gets as its session header', async () => {
    const model = faux();
    model.script(fauxAssistantMessage('ok'));
    const built = build(model);
    const { session, row } = await opened(built);
    await built.brain.prompt(session, 'hi', new Recorder(), ASKER);
    expect(model.options[0]?.sessionId).toBe(`${row.key}:main`);
  });

  test("the cost is the sum of the run's usage rows", async () => {
    const model = faux();
    model.script(
      tool('bash', { command: 'true' }),
      fauxAssistantMessage('done'),
    );
    const built = build(model);
    const { session, row } = await opened(built);
    const result = await built.brain.prompt(
      session,
      'go',
      new Recorder(),
      ASKER,
    );
    const storage = postgresStorage(database().sql, row.sessionId);
    const rows = await storage.scanUsage({}, ctx);
    await storage.close(ctx);
    // One row per model request; the faux model prices them at nothing.
    expect(rows).toHaveLength(2);
    expect(result.costUsd).toBe(
      rows.reduce((sum, usage) => sum + usage.usage.cost.total, 0),
    );
  });

  test("a provider error is the turn's error, with anything shaped like a key taken out", async () => {
    const key = `sk-${'a1b2c3d4'.repeat(4)}`;
    const model = faux();
    model.script(
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: `401 Unauthorized: bad key ${key}`,
      }),
    );
    const built = build(model);
    const { session } = await opened(built);
    const result = await built.brain.prompt(
      session,
      'hi',
      new Recorder(),
      ASKER,
    );
    expect(result.stopReason).toBe('error');
    expect(result.error).toContain('401');
    expect(result.error).not.toContain(key);
    expect(built.metrics.providerErrors).toEqual(['auth']);
    const ended = built.log.of('turn ended')[0];
    expect(ended?.level).toBe('warn');
    expect(ended?.fields).toMatchObject({
      stopReason: 'error',
      error: result.error,
    });
    expect(JSON.stringify(ended)).not.toContain(key);
  });

  test('every turn ends with one log line that says how it ended', async () => {
    const model = faux();
    model.script(fauxAssistantMessage('hello'));
    const built = build(model);
    const { session, row } = await opened(built);
    await built.brain.prompt(session, 'hi', new Recorder(), ASKER);
    const ended = built.log.of('turn ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.level).toBe('info');
    expect(ended[0]?.fields).toMatchObject({
      key: row.key,
      stopReason: 'end_turn',
      error: null,
      source: 'none',
    });
    expect(ended[0]?.fields?.firstTokenMs).toBeGreaterThanOrEqual(0);
  });

  test('a message with no text reaches the model as a note saying so', async () => {
    const inputs: string[] = [];
    const model = faux();
    model.script((context) => {
      const user = [...context.messages]
        .reverse()
        .find((message) => message.role === 'user');
      const content = user?.content;
      inputs.push(
        typeof content === 'string'
          ? content
          : (content ?? []).map((b) => ('text' in b ? b.text : '')).join(''),
      );
      return fauxAssistantMessage('what do you need?');
    });
    const built = build(model);
    const { session } = await opened(built);
    const sink = new Recorder();
    const result = await built.brain.prompt(session, '  ', sink, ASKER);
    expect(result.stopReason).toBe('end_turn');
    expect(sink.text).toBe('what do you need?');
    expect(inputs).toEqual([NO_TEXT]);
  });
});

describe('opening a thread', () => {
  test('a fresh session is not resumed; after a release and a reopen it is', async () => {
    const model = faux();
    model.script(fauxAssistantMessage('one'));
    const built = build(model);
    const { session, row } = await opened(built);
    expect(session).toMatchObject({ resumed: false, interrupted: null });
    await built.brain.prompt(session, 'hi', new Recorder(), ASKER);
    await built.brain.release(row.ref, 'quiet');
    const again = await built.brain.open(row);
    expect(again).toMatchObject({ resumed: true, interrupted: null });
  });

  test('refuses while the store is not up', async () => {
    const built = build(faux(), { db: { up: () => false } });
    const row = await built.store.open(thread());
    await expect(built.brain.open(row)).rejects.toBeInstanceOf(
      BrainUnavailable,
    );
  });

  test('a store that does not answer is BrainUnavailable within the bound', async () => {
    const { SQL } = await import('bun');
    const dead = new SQL('postgres://postgres@127.0.0.1:1/postgres', {
      max: 1,
      connectionTimeout: 3,
    });
    const built = build(faux(), {
      sessions: postgresSessions(dead),
      timeouts: { open: 1_000 },
    });
    const row = await built.store.open(thread());
    const started = performance.now();
    await expect(built.brain.open(row)).rejects.toBeInstanceOf(
      BrainUnavailable,
    );
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(built.metrics.storeFailures).toContain('open');
    void dead.close();
  });

  test("a lane saved by an older mate is brought to today's model, thinking level and tools", async () => {
    const old = faux('faux-old', 'off');
    old.script(fauxAssistantMessage('old'));
    const first = build(old);
    const { session, row } = await opened(first);
    await first.brain.prompt(session, 'hi', new Recorder(), ASKER);
    await first.brain.release(row.ref, 'quiet');
    expect(await lane(row.sessionId)).toMatchObject({
      model: { provider: 'faux', modelId: 'faux-old' },
      thinkingLevel: 'off',
    });

    const next = faux('faux-new', 'low');
    const mcp = new FakeBridge([kthxTool('kthx_list')]);
    const second = build(next, { mcp });
    await second.brain.open(row);
    const config = await lane(row.sessionId);
    expect(config).toMatchObject({
      model: { provider: 'faux', modelId: 'faux-new' },
      thinkingLevel: 'low',
    });
    expect(config?.activeToolNames).toContain('kthx_list');
    expect(config?.activeToolNames).toContain('bash');
  });
});

describe('Stop', () => {
  test('mid-stream is cancelled', async () => {
    const model = faux();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.script(async () => {
      await held;
      return fauxAssistantMessage('too late');
    });
    const built = build(model);
    const { session } = await opened(built);
    const running = built.brain.prompt(session, 'hi', new Recorder(), ASKER);
    await Bun.sleep(50);
    await built.brain.cancel(session);
    release();
    expect((await running).stopReason).toBe('cancelled');
  });

  test('before the prompt is admitted is cancelled right after it is', async () => {
    const model = faux();
    model.script(fauxAssistantMessage('should not stream'));
    const built = build(model);
    const { session } = await opened(built);
    const running = built.brain.prompt(session, 'hi', new Recorder(), ASKER);
    await built.brain.cancel(session);
    expect((await running).stopReason).toBe('cancelled');
  });

  test('a run that will not settle is closed under the turn after the grace, and the thread recovers once the close drains', async () => {
    const faults = plan();
    const sessions = sessionsWith((_, storage) => new Faulty(storage, faults));
    const answer = gate();
    const called = gate();
    const model = faux();
    model.script(
      async () => {
        called.open();
        await answer.wait;
        return fauxAssistantMessage('streamed into a stalled store');
      },
      ...Array.from({ length: 4 }, () => fauxAssistantMessage('answered')),
    );
    const built = build(model, {
      sessions,
      timeouts: { stopGrace: 100, harnessClose: 50, discard: 500 },
    });
    const { session } = await opened(built);
    const running = built.brain.prompt(session, 'hi', new Recorder(), ASKER);
    // This run takes the first reply, so it is never left for the third prompt.
    await called.wait;
    // mate-db stops answering, so every commit from here on waits, and so
    // does the abort, which queues behind them.
    const stalled = gate();
    faults.holdCommit = stalled.wait;
    answer.open();
    await Bun.sleep(20);
    await built.brain.cancel(session);
    const stopped = await running;
    expect(stopped.stopReason).toBe('cancelled');
    expect(
      built.log.of('the run would not settle; closing its harness')[0]?.fields,
    ).toMatchObject({ after: 'stopped' });

    const refused = await built.brain.prompt(
      session,
      'two',
      new Recorder(),
      ASKER,
    );
    expect(refused).toMatchObject({ stopReason: 'error', error: RECOVERING });

    faults.holdCommit = null;
    stalled.open();
    await Bun.sleep(50);
    const sink = new Recorder();
    const third = await built.brain.prompt(session, 'three', sink, ASKER);
    expect(third.stopReason).toBe('end_turn');
    expect(sink.text).toBe('answered');
    expect(sessions.opened).toHaveLength(2);
  });

  test('a SIGTERM while the run will not settle leaves it abandoned, not stopped', async () => {
    const faults = plan();
    const sessions = sessionsWith((_, storage) => new Faulty(storage, faults));
    const answer = gate();
    const called = gate();
    const model = faux();
    model.script(async () => {
      called.open();
      await answer.wait;
      return fauxAssistantMessage('streamed into a stalled store');
    });
    const built = build(model, {
      sessions,
      timeouts: { stopGrace: 100, harnessClose: 50, abandonClose: 50 },
    });
    const { session } = await opened(built);
    const outcome = built.brain
      .prompt(session, 'hi', new Recorder(), ASKER)
      .then(
        () => null,
        (error: unknown) => error,
      );
    await called.wait;
    const stalled = gate();
    faults.holdCommit = stalled.wait;
    answer.open();
    await Bun.sleep(20);
    await built.brain.cancel(session);
    await built.brain.abandon();
    expect(await outcome).toBeInstanceOf(TurnAbandoned);
    stalled.open();
  });
});

describe('the turn timeout', () => {
  test('aborts the run and says how long it ran', async () => {
    const model = faux();
    model.script(
      tool('bash', { command: 'sleep 30' }),
      fauxAssistantMessage('never'),
    );
    const built = build(model, {
      turnTimeoutMs: 300,
      timeouts: { timeoutGrace: 2_000 },
    });
    const { session } = await opened(built);
    const result = await built.brain.prompt(
      session,
      'wait',
      new Recorder(),
      ASKER,
    );
    expect(result.stopReason).toBe('error');
    expect(result.error).toBe('turn ran past 0.005 min');
    expect(built.hands.log).toContain('exec-aborted');
  });

  test('a run that ignores the abort is closed after the grace, and the thread recovers once the close drains', async () => {
    const faults = plan();
    const sessions = sessionsWith((_, storage) => new Faulty(storage, faults));
    const exec = gate();
    const model = faux();
    model.script(
      tool('bash', { command: 'sleep 30' }),
      ...Array.from({ length: 4 }, () => fauxAssistantMessage('answered')),
    );
    const built = build(model, {
      sessions,
      hands: {
        root,
        hold: (method) => (method === 'exec' ? exec.wait : null),
      },
      turnTimeoutMs: 300,
      timeouts: { timeoutGrace: 100, harnessClose: 50, discard: 500 },
    });
    const { session } = await opened(built);
    let drain = () => {};
    faults.holdClose = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const first = await built.brain.prompt(
      session,
      'wait',
      new Recorder(),
      ASKER,
    );
    expect(first).toMatchObject({
      stopReason: 'error',
      error: 'turn ran past 0.005 min',
    });

    const refused = await built.brain.prompt(
      session,
      'two',
      new Recorder(),
      ASKER,
    );
    expect(refused).toMatchObject({ stopReason: 'error', error: RECOVERING });
    expect(sessions.opened).toHaveLength(1);

    faults.holdClose = null;
    drain();
    exec.open();
    await Bun.sleep(20);
    const sink = new Recorder();
    const third = await built.brain.prompt(session, 'three', sink, ASKER);
    expect(third.stopReason).toBe('end_turn');
    expect(sink.text).toBe('answered');
    expect(sessions.opened).toHaveLength(2);
  });
});

/** Storage whose restore breaks pi's invariants, as a corrupt session would. */
class Corrupt extends StorageDecorator {
  override getValue<T>(_address: Value<T>, _context: Context): never {
    throw new SessionInvariantError('corrupt lane state');
  }
  override scanValues<T>(_prefix: Value<T>, _context: Context): never {
    throw new SessionInvariantError('corrupt lane state');
  }
}

/** Opens each id through `wrap`, so a test can corrupt or gate one. */
function sessionsWith(
  wrap: (id: string, storage: Storage) => Storage,
): SessionSource & { opened: string[] } {
  const { sql } = database();
  const opened: string[] = [];
  return {
    opened,
    open: async (id) => {
      opened.push(id);
      await (await openSession(sql, { id })).close(ctx);
      return new StorageBackedSession(
        { id, createdAt: Date.now(), storageVersion: POSTGRES_STORAGE_VERSION },
        wrap(id, postgresStorage(sql, id)),
      );
    },
    delete: postgresSessions(sql).delete,
  };
}

describe('a session that will not open', () => {
  test("one that breaks pi's invariants twice is set aside, and a fresh one opens", async () => {
    const sessions = sessionsWith((id, storage) =>
      id.includes('~') ? storage : new Corrupt(storage),
    );
    const built = build(faux(), { sessions });
    const row = await built.store.open(thread());
    const session = await built.brain.open(row);
    expect(session.resumed).toBe(false);
    expect(sessions.opened).toEqual([row.key, row.key, `${row.key}~1`]);
    const stored = await built.store.get(row.key);
    expect(stored?.sessionId).toBe(`${row.key}~1`);
    expect(stored?.quarantined).toEqual([row.key]);
    expect(await sessionExists(database().sql, row.key)).toBe(true);
    expect(built.metrics.storeFailures).toContain('quarantine');
    expect(built.log.of('a session was set aside')[0]?.fields?.why).toBe(
      'corrupt lane state',
    );
  });

  test('one that breaks them once opens on the retry, and nothing is set aside', async () => {
    let corrupt = 1;
    const sessions = sessionsWith((_, storage) =>
      corrupt-- > 0 ? new Corrupt(storage) : storage,
    );
    const built = build(faux(), { sessions });
    const row = await built.store.open(thread());
    await built.brain.open(row);
    expect(sessions.opened).toEqual([row.key, row.key]);
    const stored = await built.store.get(row.key);
    expect(stored?.sessionId).toBe(row.key);
    expect(stored?.quarantined).toEqual([]);
    expect(built.metrics.storeFailures).not.toContain('quarantine');
  });

  test('anything else is BrainUnavailable, and every session stays', async () => {
    const failures: [string, () => never][] = [
      [
        "the store's version refusal",
        () => {
          throw new Error('pi-store: session x has storage version 2, not 1');
        },
      ],
      [
        'an unclassified SQL error',
        () => {
          throw Object.assign(new Error('relation does not exist'), {
            errno: '42P01',
          });
        },
      ],
    ];
    for (const [, fail] of failures) {
      const built = build(faux(), {
        sessions: { open: async () => fail(), delete: async () => {} },
      });
      const row = await built.store.open(thread());
      await expect(built.brain.open(row)).rejects.toBeInstanceOf(
        BrainUnavailable,
      );
      expect((await built.store.get(row.key))?.quarantined).toEqual([]);
    }

    const bug = build(faux(), {
      retry: { enabled: true, maxRetries: -1, baseDelayMs: 1 },
    });
    const row = await bug.store.open(thread());
    await expect(bug.brain.open(row)).rejects.toBeInstanceOf(BrainUnavailable);
    expect(bug.log.of('the session could not be opened')[0]?.level).toBe(
      'error',
    );
    expect(await sessionExists(database().sql, row.key)).toBe(true);
  });

  test('a fourth quarantine within the hour is refused', async () => {
    const built = build(faux(), {
      sessions: sessionsWith((_, storage) => new Corrupt(storage)),
    });
    for (let i = 0; i < 3; i += 1) {
      const row = await built.store.open(thread());
      // Each fresh session is corrupt too, so the open still fails.
      await expect(built.brain.open(row)).rejects.toBeInstanceOf(
        BrainUnavailable,
      );
    }
    const row = await built.store.open(thread());
    await expect(built.brain.open(row)).rejects.toBeInstanceOf(
      BrainUnavailable,
    );
    expect((await built.store.get(row.key))?.quarantined).toEqual([]);
    expect(
      built.log.of(
        'too many sessions set aside this hour; refusing to set aside another',
      ),
    ).toHaveLength(1);
  });
});

class FakeBridge implements McpBridge {
  private readonly listeners = new Set<() => void>();
  constructor(private listed: BridgedTool[] = []) {}
  tools(): readonly BridgedTool[] {
    return this.listed;
  }
  set(tools: BridgedTool[]): void {
    this.listed = tools;
    for (const listener of this.listeners) listener();
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): void {}
  async ready(): Promise<boolean> {
    return this.listed.length > 0;
  }
  async close(): Promise<void> {}
}

function kthxTool(
  name: string,
  execute: () => Promise<string> = async () => 'listed',
): BridgedTool {
  return {
    ...unreachableTool(name),
    description: 'a kthx tool',
    execute: async () => ({
      content: [{ type: 'text', text: await execute() }],
      details: undefined,
    }),
  };
}

/** What a test does to the commits and closes of the sessions it opens. */
interface Plan {
  /** Commits after this many from now fail, as a dropped connection would. */
  failAfter: number | null;
  seen: number;
  delayMs: number;
  /** Commits wait on this, as they would on a mate-db that stopped answering. */
  holdCommit: Promise<void> | null;
  holdClose: Promise<void> | null;
}

class Faulty extends StorageDecorator {
  constructor(
    delegate: Storage,
    private readonly plan: Plan,
  ) {
    super(delegate);
  }

  override async commit(writes: Write[], context: Context) {
    const { plan } = this;
    if (plan.failAfter !== null && plan.seen++ >= plan.failAfter) {
      throw new Error('the connection to mate-db dropped');
    }
    if (plan.delayMs > 0) await Bun.sleep(plan.delayMs);
    await plan.holdCommit;
    return super.commit(writes, context);
  }

  override async close(context: Context): Promise<void> {
    await this.plan.holdClose;
    await super.close(context);
  }
}

function plan(): Plan {
  return {
    failAfter: null,
    seen: 0,
    delayMs: 0,
    holdCommit: null,
    holdClose: null,
  };
}

/** Fails commits from the next one after `after`, counting from now. */
function failFrom(target: Plan, after: number): void {
  target.failAfter = after;
  target.seen = 0;
}

function answers(model: Faux, text: string, count = 8): void {
  model.script(
    ...Array.from({ length: count }, () => fauxAssistantMessage(text)),
  );
}

describe('a harness that faults', () => {
  test('gives an error, and the next prompt opens a new session, discards the open run and answers', async () => {
    const faults = plan();
    const sessions = sessionsWith((_, storage) => new Faulty(storage, faults));
    const model = faux();
    answers(model, 'answered');
    const built = build(model, { sessions });
    const { session, row } = await opened(built);
    // The prompt is admitted, then the run's next commit is lost.
    failFrom(faults, 1);
    const first = await built.brain.prompt(
      session,
      'one',
      new Recorder(),
      ASKER,
    );
    expect(first.stopReason).toBe('error');
    expect(first.error).toBe(
      'mate lost its session state mid-turn: the connection to mate-db dropped',
    );
    expect(built.metrics.storeFailures).toContain('fault');
    expect(built.log.of('the harness faulted')[0]?.fields?.cause).toBe(
      'the connection to mate-db dropped',
    );

    faults.failAfter = null;
    const sink = new Recorder();
    const second = await built.brain.prompt(session, 'two', sink, ASKER);
    expect(second.stopReason).toBe('end_turn');
    expect(sink.text).toBe('answered');
    expect(sessions.opened).toEqual([row.sessionId, row.sessionId]);
  });

  test('refuses prompts while its close still drains, and opens no second harness', async () => {
    const faults = plan();
    const sessions = sessionsWith((_, storage) => new Faulty(storage, faults));
    const model = faux();
    answers(model, 'answered');
    const built = build(model, {
      sessions,
      timeouts: { harnessClose: 50 },
    });
    const { session } = await opened(built);
    let drain = () => {};
    faults.holdClose = new Promise<void>((resolve) => {
      drain = resolve;
    });
    failFrom(faults, 0);
    const first = await built.brain.prompt(
      session,
      'one',
      new Recorder(),
      ASKER,
    );
    expect(first.stopReason).toBe('error');

    const refused = await built.brain.prompt(
      session,
      'two',
      new Recorder(),
      ASKER,
    );
    expect(refused).toMatchObject({ stopReason: 'error', error: RECOVERING });
    expect(sessions.opened).toHaveLength(1);

    faults.failAfter = null;
    faults.holdClose = null;
    drain();
    await Bun.sleep(20);
    const sink = new Recorder();
    const third = await built.brain.prompt(session, 'three', sink, ASKER);
    expect(third.stopReason).toBe('end_turn');
    expect(sink.text).toBe('answered');
    expect(sessions.opened).toHaveLength(2);
  });

  test('a discard whose abort runs past its deadline waits for idle before the prompt', async () => {
    const faults = plan();
    const sessions = sessionsWith((_, storage) => new Faulty(storage, faults));
    const model = faux();
    answers(model, 'answered');
    const built = build(model, {
      sessions,
      // The abort makes two delayed commits, so it always runs past the
      // deadline, and the idle wait after it has most of a deadline to spare.
      timeouts: { discard: 190 },
    });
    const { session } = await opened(built);
    failFrom(faults, 1);
    await built.brain.prompt(session, 'one', new Recorder(), ASKER);

    faults.failAfter = null;
    faults.delayMs = 100;
    const sink = new Recorder();
    const second = await built.brain.prompt(session, 'two', sink, ASKER);
    expect(
      built.log.of('the abort ran past its deadline; waiting for the lane'),
    ).toHaveLength(1);
    expect(second.stopReason).toBe('end_turn');
    expect(sink.text).toBe('answered');
  });

  test('two in a row set the session aside, and the thread starts afresh', async () => {
    const faults = plan();
    const sessions = sessionsWith((id, storage) =>
      id.includes('~') ? storage : new Faulty(storage, faults),
    );
    const model = faux();
    answers(model, 'fresh');
    const built = build(model, { sessions });
    const { session, row } = await opened(built);
    failFrom(faults, 0);
    for (const text of ['one', 'two']) {
      const result = await built.brain.prompt(
        session,
        text,
        new Recorder(),
        ASKER,
      );
      expect(result.stopReason).toBe('error');
    }
    const setAside = await built.brain.prompt(
      session,
      'three',
      new Recorder(),
      ASKER,
    );
    expect(setAside).toMatchObject({ stopReason: 'error', reset: true });
    const stored = await built.store.get(row.key);
    expect(stored?.sessionId).toBe(`${row.key}~1`);
    expect(stored?.quarantined).toEqual([row.key]);
    expect(await sessionExists(database().sql, row.key)).toBe(true);
    expect((await built.brain.open(row)).resumed).toBe(false);

    const sink = new Recorder();
    const after = await built.brain.prompt(session, 'four', sink, ASKER);
    expect(after.stopReason).toBe('end_turn');
    expect(sink.text).toBe('fresh');
    expect(model.options.at(-1)?.sessionId).toBe(`${row.key}~1:main`);
  });

  test('a set-aside whose row write fails is not counted toward the hourly limit', async () => {
    const faults = plan();
    const sessions = sessionsWith((id, storage) =>
      id.includes('~') ? storage : new Faulty(storage, faults),
    );
    const model = faux();
    answers(model, 'fresh');
    const built = build(model, { sessions });
    let rowsDown = false;
    const patch = built.store.patch.bind(built.store);
    built.store.patch = async (key, change) => {
      if (rowsDown) {
        throw Object.assign(new Error('Connection refused'), {
          code: 'ERR_POSTGRES_CONNECTION_REFUSED',
        });
      }
      return patch(key, change);
    };
    const { session, row } = await opened(built);
    failFrom(faults, 0);
    for (const text of ['one', 'two']) {
      await built.brain.prompt(session, text, new Recorder(), ASKER);
    }
    // mate-db blips for three prompts, each of which tries to set it aside.
    rowsDown = true;
    for (const text of ['a', 'b', 'c']) {
      await expect(
        built.brain.prompt(session, text, new Recorder(), ASKER),
      ).rejects.toBeInstanceOf(BrainUnavailable);
    }
    rowsDown = false;
    faults.failAfter = null;
    const setAside = await built.brain.prompt(
      session,
      'back',
      new Recorder(),
      ASKER,
    );
    expect(setAside).toMatchObject({ stopReason: 'error', reset: true });
    expect((await built.store.get(row.key))?.quarantined).toEqual([row.key]);
    expect(
      built.log.of(
        'too many sessions set aside this hour; refusing to set aside another',
      ),
    ).toEqual([]);
  });
});

describe('a mate-db that stops answering', () => {
  test('faults the turn once the pool has heard nothing for its idle timeout', async () => {
    const proxy = stallingProxy(database().url);
    // Scaled down from 30 s and 10 s: the client's bounds on a silent
    // connection and on the store's retry of it.
    const sql = new SQL(proxy.url, {
      ...POOL_OPTIONS,
      idleTimeout: 1,
      connectionTimeout: 1,
    });
    const answer = gate();
    const model = faux();
    model.script(async () => {
      await answer.wait;
      return fauxAssistantMessage('streamed into a silent store');
    });
    const built = build(model, {
      sessions: postgresSessions(sql),
      timeouts: { harnessClose: 3_000 },
    });
    try {
      const { session } = await opened(built);
      const running = built.brain.prompt(session, 'hi', new Recorder(), ASKER);
      await Bun.sleep(50);
      proxy.freeze();
      answer.open();
      const started = performance.now();
      const result = await running;
      expect(performance.now() - started).toBeLessThan(4_000);
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('mate lost its session state mid-turn');
      expect(built.metrics.storeFailures).toContain('fault');
    } finally {
      proxy.stop();
      await sql.close({ timeout: 0 });
    }
  });
});

/** The messages pi keeps for a session's main lane, oldest first. */
async function transcript(sessionId: string): Promise<AgentMessage[]> {
  const session = await openSession(database().sql, { id: sessionId });
  const branch = await session.branch('main', ctx);
  const entries = branch
    ? await branch.findEntries({ order: 'oldestFirst' }, ctx)
    : [];
  await session.close(ctx);
  return entries.flatMap((entry) =>
    entry.type === 'message' ? [entry.message] : [],
  );
}

function toolText(messages: AgentMessage[], toolCallId: string): string {
  const result = messages.find(
    (message) =>
      'role' in message &&
      message.role === 'toolResult' &&
      message.toolCallId === toolCallId,
  );
  if (!result || !('content' in result) || typeof result.content === 'string') {
    return '';
  }
  return result.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('');
}

const INTERRUPTED = 'Tool execution was interrupted';

function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('timed out waiting');
    await Bun.sleep(5);
  }
}

describe('a restart mid-turn', () => {
  test('abandons the turn under SIGTERM, and a new brain resumes it: bash is interrupted and read runs again', async () => {
    const held = gate();
    const model = faux();
    model.script(
      fauxAssistantMessage(
        [
          fauxToolCall('bash', { command: 'sleep 30' }, { id: 'c-bash' }),
          fauxToolCall('read', { path: 'notes.txt' }, { id: 'c-read' }),
        ],
        { stopReason: 'toolUse' },
      ),
    );
    const first = build(model, {
      hands: {
        root,
        hold: (method) => (method === 'readBinaryFile' ? held.wait : null),
      },
    });
    const { session, row } = await opened(first);
    const card = new Recorder();
    const running = first.brain.prompt(session, 'go', card, ASKER);
    const outcome = running.then(
      () => null,
      (error: unknown) => error,
    );
    await until(() =>
      ['exec', 'readBinaryFile'].every((method) =>
        first.hands.calls.some((call) => call.method === method),
      ),
    );
    const drawn = card.updates.length;
    await first.brain.abandon();
    expect(await outcome).toBeInstanceOf(TurnAbandoned);
    // The card is left as it was: its status line and Stop button stay.
    expect(card.updates.slice(drawn)).toEqual([]);
    const log = first.hands.log;
    expect(log.indexOf('exec-aborted')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('exec-aborted')).toBeLessThan(log.indexOf('abandon'));
    expect(log).not.toContain('finish');

    const next = faux();
    next.script(fauxAssistantMessage('picked it back up'));
    const second = build(next);
    const reopened = await second.brain.open(row);
    expect(reopened.interrupted).not.toBeNull();
    const sink = new Recorder();
    const resumed = await second.brain.resume(reopened, sink, ASKER);
    expect(resumed.stopReason).toBe('end_turn');
    expect(sink.text).toBe('picked it back up');
    // pi ends the interrupted bash without starting it again.
    expect(sink.cards).toContainEqual({
      id: 'c-bash',
      title: '$ sleep 30',
      state: 'error',
    });
    expect(second.hands.log[0]).toBe('warm');
    const said = await transcript(row.sessionId);
    expect(toolText(said, 'c-bash')).toContain(INTERRUPTED);
    expect(toolText(said, 'c-read')).toContain('the notes');
    expect(
      second.hands.calls.filter((call) => call.method === 'readBinaryFile'),
    ).toHaveLength(1);
    held.open();
  });

  for (const point of ['tool start', 'after the tool ended', 'mid-stream']) {
    test(`a crash at ${point} resumes to the answer`, async () => {
      const held = gate();
      const model = faux();
      const steps: FauxResponseStep[] = [
        tool('bash', { command: 'echo ran' }, 'c-point'),
      ];
      if (point === 'after the tool ended') {
        steps.push(async () => {
          await held.wait;
          return fauxAssistantMessage('never seen');
        });
      } else {
        steps.push(fauxAssistantMessage('never seen'));
      }
      if (point === 'mid-stream') {
        model.script(async () => {
          await Bun.sleep(1);
          return fauxAssistantMessage(`${'streaming words '.repeat(200)}`);
        });
      } else {
        model.script(...steps);
      }
      const first = build(model, {
        hands: {
          root,
          hold: (method) =>
            point === 'tool start' && method === 'exec' ? held.wait : null,
        },
      });
      const { session, row } = await opened(first);
      const sink = new Recorder();
      const outcome = first.brain.prompt(session, 'go', sink, ASKER).then(
        () => null,
        (error: unknown) => error,
      );
      if (point === 'tool start') {
        await until(() => first.hands.calls.some((c) => c.method === 'exec'));
      } else if (point === 'after the tool ended') {
        await until(() => sink.cards.some((card) => card.state === 'complete'));
        await Bun.sleep(20);
      } else {
        await until(() => sink.text.length > 0);
      }
      await first.brain.abandon();
      expect(await outcome).toBeInstanceOf(TurnAbandoned);
      held.open();

      const next = faux();
      answers(next, 'the answer');
      const second = build(next);
      const reopened = await second.brain.open(row);
      expect(reopened.interrupted).not.toBeNull();
      const resumed = new Recorder();
      const result = await second.brain.resume(reopened, resumed, ASKER);
      expect(result.stopReason).toBe('end_turn');
      expect(resumed.text).toContain('the answer');
    });
  }

  for (const bridge of ['a bridge that lists nothing', 'no bridge'] as const) {
    test(`a run cut off while a kthx tool was active resumes with ${bridge}, and the tool answers that kthx is unreachable`, async () => {
      const held = gate();
      const called = gate();
      const model = faux();
      model.script(tool('kthx_x', { app: 'a' }, 'c-kthx'));
      const first = build(model, {
        mcp: new FakeBridge([
          kthxTool('kthx_x', async () => {
            called.open();
            await held.wait;
            return 'too late';
          }),
        ]),
      });
      const { session, row } = await opened(first);
      const outcome = first.brain
        .prompt(session, 'deploy', new Recorder(), ASKER)
        .then(
          () => null,
          (error: unknown) => error,
        );
      await called.wait;
      await first.brain.abandon();
      expect(await outcome).toBeInstanceOf(TurnAbandoned);

      const next = faux();
      next.script(
        tool('kthx_x', { app: 'a' }, 'c-again'),
        fauxAssistantMessage('kthx is down, try later'),
      );
      const second = build(next, {
        mcp: bridge === 'no bridge' ? null : new FakeBridge([]),
        timeouts: { mcpBootWait: 10 },
      });
      const reopened = await second.brain.open(row);
      expect(reopened.interrupted).not.toBeNull();
      const sink = new Recorder();
      const result = await second.brain.resume(reopened, sink, ASKER);
      expect(result.stopReason).toBe('end_turn');
      expect(sink.text).toBe('kthx is down, try later');
      const said = await transcript(row.sessionId);
      expect(toolText(said, 'c-kthx')).toContain(INTERRUPTED);
      expect(toolText(said, 'c-again')).toContain('kthx is unreachable');
      held.open();
    });
  }
});

describe('a sandbox that went away between turns', () => {
  test('is told to the model once, at the start of the next prompt', async () => {
    const inputs: string[] = [];
    const model = faux();
    const record: FauxResponseStep = (context) => {
      const user = [...context.messages]
        .reverse()
        .find((message) => message.role === 'user');
      const content = user?.content;
      inputs.push(
        typeof content === 'string'
          ? content
          : (content ?? []).map((b) => ('text' in b ? b.text : '')).join(''),
      );
      return fauxAssistantMessage('ok');
    };
    model.script(tool('bash', { command: 'true' }), record, record, record);
    const built = build(model);
    const { session, row } = await opened(built);
    await built.brain.prompt(session, 'use a tool', new Recorder(), ASKER);
    await built.brain.release(row.ref, 'quiet');
    expect((await built.store.get(row.key))?.workspaceReset).toBe('quiet');

    const reopened = await built.brain.open(await built.store.open(row.ref));
    await built.brain.prompt(reopened, 'next', new Recorder(), ASKER);
    await built.brain.prompt(reopened, 'and next', new Recorder(), ASKER);
    expect(inputs.at(-2)).toBe(`${resetNote('quiet')}\n\nnext`);
    expect(inputs.at(-1)).toBe('and next');
    expect((await built.store.get(row.key))?.workspaceReset).toBeNull();
  });
});

describe('putting threads away', () => {
  test('forget deletes the current session and every quarantined one', async () => {
    const built = build(faux());
    const ref = thread();
    const row = await built.store.open(ref);
    const { sql } = database();
    for (const id of [row.key, `${row.key}~1`]) {
      await (await openSession(sql, { id })).close(ctx);
    }
    await built.store.patch(row.key, {
      sessionId: `${row.key}~1`,
      quarantined: [row.key],
    });
    await built.brain.open((await built.store.get(row.key)) as ThreadRow);
    await built.brain.forget(ref);
    expect(await sessionExists(sql, row.key)).toBe(false);
    expect(await sessionExists(sql, `${row.key}~1`)).toBe(false);
    expect(built.hands.released).toEqual([
      { key: threadKey(ref), reason: 'thread-deleted' },
    ]);
  });

  test('retention deletes old closed threads, but not one reopened meanwhile or one still open here', async () => {
    const { sql } = database();
    const clock = new FakeClock();
    const rows = new PostgresThreadStore(sql, clock);
    let reply: ThreadRef | null = null;
    const store = Object.assign(Object.create(rows) as PostgresThreadStore, {
      closedBefore: async (before: number, limit: number) => {
        const found = await rows.closedBefore(before, limit);
        // A reply lands between the listing and the delete.
        if (reply) await rows.open(reply);
        return found;
      },
    });
    const built = build(faux(), { store, clock });
    const old = await rows.open(thread());
    const reopened = await rows.open(thread());
    const live = await rows.open(thread());
    for (const row of [old, reopened, live]) {
      await (await openSession(sql, { id: row.sessionId })).close(ctx);
    }
    await built.brain.open(live);
    for (const row of [old, reopened, live]) {
      await rows.patch(row.key, { state: 'closed' });
    }
    reply = reopened.ref;
    await clock.advance(20 * 86_400_000);

    await built.brain.sweep(clock.now() - 14 * 86_400_000);
    expect(await rows.get(old.key)).toBeUndefined();
    expect(await sessionExists(sql, old.sessionId)).toBe(false);
    expect((await rows.get(reopened.key))?.state).toBe('open');
    expect(await sessionExists(sql, reopened.sessionId)).toBe(true);
    expect(await rows.get(live.key)).toBeDefined();
    expect(await sessionExists(sql, live.sessionId)).toBe(true);
  });
});

interface Routed {
  readonly setup: ModelSetup;
  /** The pre-cutover lane: qwen3.8-max, with nothing routed. */
  readonly unrouted: ModelSetup;
  codex(...steps: FauxResponseStep[]): void;
  go(...steps: FauxResponseStep[]): void;
  readonly asked: string[];
}

/** mate's two providers, played by faux ones that carry their ids. */
function routed(): Routed {
  const asked: string[] = [];
  const track =
    (step: FauxResponseStep): FauxResponseStep =>
    (context, streamOptions, state, requested) => {
      asked.push(`${requested.provider}/${requested.id}`);
      return typeof step === 'function'
        ? step(context, streamOptions, state, requested)
        : step;
    };
  const codex = fauxProvider({
    api: 'faux-codex',
    provider: CHATGPT_PROVIDER,
    tokenSize: { min: 3, max: 3 },
    models: [{ id: 'gpt-6-sol', reasoning: true, cost: price }],
  });
  const go = fauxProvider({
    api: 'faux-go',
    provider: 'opencode-go',
    tokenSize: { min: 3, max: 3 },
    models: [{ id: 'qwen3.8-max', reasoning: true, cost: price }],
  });
  const inner = createModels();
  inner.setProvider(codex.provider);
  inner.setProvider(go.provider);
  const primary = codex.getModel('gpt-6-sol');
  const fallback = go.getModel('qwen3.8-max');
  if (!primary || !fallback) throw new Error('no faux models');
  const { models, router } = routeModels(inner, {
    primary,
    fallback: { model: fallback, thinking: 'medium' },
    clock: systemClock,
    log: silentLog,
  });
  return {
    setup: {
      models,
      direct: inner,
      model: primary,
      thinking: 'medium',
      router,
    },
    unrouted: {
      models: inner,
      direct: inner,
      model: fallback,
      thinking: 'medium',
      router: null,
    },
    codex: (...steps) => codex.appendResponses(steps.map(track)),
    go: (...steps) => go.appendResponses(steps.map(track)),
    asked,
  };
}

const usageLimit = () =>
  fauxAssistantMessage([], {
    stopReason: 'error',
    errorMessage: 'Codex error: The usage limit has been reached',
  });

describe('a routed model', () => {
  test('a tool turn whose second step ChatGPT cannot answer finishes on qwen3.8-max, says why in its status line, and carries the notice once', async () => {
    const models = routed();
    models.codex(tool('bash', { command: 'true' }), usageLimit());
    models.go(fauxAssistantMessage('done on qwen'));
    const built = build({ ...faux(), setup: models.setup });
    const { session } = await opened(built);
    const sink = new Recorder();
    const result = await built.brain.prompt(session, 'go', sink, ASKER);
    expect(result.stopReason).toBe('end_turn');
    expect(sink.text).toBe('done on qwen');
    expect(models.asked).toEqual([
      'openai-codex/gpt-6-sol',
      'openai-codex/gpt-6-sol',
      'opencode-go/qwen3.8-max',
    ]);
    const lines = sink.updates.flatMap((u) =>
      u.kind === 'status' && u.line ? [u.line] : [],
    );
    expect(lines).toContain(
      "↪️ qwen3.8-max is answering — ChatGPT's usage limit is reached",
    );
    expect(result.notice).toStartWith(LIMIT_FALLBACK);
    expect(built.log.of('turn ended')[0]?.fields).toMatchObject({
      route: 'mixed',
    });

    models.go(fauxAssistantMessage('qwen again'));
    const next = await built.brain.prompt(
      session,
      'more',
      new Recorder(),
      ASKER,
    );
    expect(next.stopReason).toBe('end_turn');
    expect(next.notice).toBeUndefined();
    expect(built.log.of('turn ended')[1]?.fields).toMatchObject({
      route: 'fallback',
    });
  });

  test('a turn ChatGPT answers alone has no notice and no ↪️ line', async () => {
    const models = routed();
    models.codex(fauxAssistantMessage('from ChatGPT'));
    const built = build({ ...faux(), setup: models.setup });
    const { session } = await opened(built);
    const sink = new Recorder();
    const result = await built.brain.prompt(session, 'hi', sink, ASKER);
    expect(result.notice).toBeUndefined();
    expect(
      sink.updates.some((u) => u.kind === 'status' && u.line?.startsWith('↪️')),
    ).toBe(false);
    expect(built.log.of('turn ended')[0]?.fields).toMatchObject({
      route: 'primary',
    });
  });

  test('a lane saved on qwen3.8-max is brought to ChatGPT at its next open', async () => {
    const models = routed();
    models.go(fauxAssistantMessage('old'));
    const first = build({ ...faux(), setup: models.unrouted });
    const { session, row } = await opened(first);
    await first.brain.prompt(session, 'hi', new Recorder(), ASKER);
    await first.brain.release(row.ref, 'quiet');
    expect(await lane(row.sessionId)).toMatchObject({
      model: { provider: 'opencode-go', modelId: 'qwen3.8-max' },
    });
    const second = build({ ...faux(), setup: models.setup });
    await second.brain.open(row);
    expect(await lane(row.sessionId)).toMatchObject({
      model: { provider: CHATGPT_PROVIDER, modelId: 'gpt-6-sol' },
      thinkingLevel: 'medium',
    });
  });

  test('a step a restart cut off on qwen3.8-max resumes on it, straight through the router', async () => {
    const models = routed();
    const asked = gate();
    // The step never answers: SIGTERM finds it waiting on the model.
    models.go(() => {
      asked.open();
      return new Promise(() => {});
    });
    const first = build(
      { ...faux(), setup: models.unrouted },
      { timeouts: { abandonClose: 100 } },
    );
    const { session, row } = await opened(first);
    const running = first.brain
      .prompt(session, 'go', new Recorder(), ASKER)
      .catch((error: unknown) => error);
    await asked.wait;
    await first.brain.abandon();
    expect(await running).toBeInstanceOf(TurnAbandoned);

    models.go(fauxAssistantMessage('picked up on qwen'));
    const second = build({ ...faux(), setup: models.setup });
    const reopened = await second.brain.open(row);
    expect(reopened.interrupted).not.toBeNull();
    const sink = new Recorder();
    const resumed = await second.brain.resume(reopened, sink, ASKER);
    expect(resumed.stopReason).toBe('end_turn');
    expect(sink.text).toBe('picked up on qwen');
    expect(models.asked).toEqual([
      'opencode-go/qwen3.8-max',
      'opencode-go/qwen3.8-max',
    ]);
    expect(resumed.notice).toBeUndefined();
  });

  test("both failing is the fallback's own kind of error, after the clause for ChatGPT", async () => {
    const models = routed();
    models.codex(usageLimit());
    models.go(
      fauxAssistantMessage([], {
        stopReason: 'error',
        errorMessage: '401 Unauthorized',
      }),
    );
    const built = build(
      { ...faux(), setup: models.setup },
      { retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 } },
    );
    const { session } = await opened(built);
    const result = await built.brain.prompt(
      session,
      'hi',
      new Recorder(),
      ASKER,
    );
    expect(result.error).toBe(
      "ChatGPT's usage limit is reached; opencode-go/qwen3.8-max: 401 Unauthorized",
    );
    expect(built.metrics.providerErrors).toEqual(['auth']);
  });
});

describe('providerErrorKind', () => {
  test.each([
    ['You have hit your ChatGPT usage limit (prolite plan).', 'limit'],
    ['GoUsageLimitError: available balance', 'limit'],
    ['401 Unauthorized', 'auth'],
    ['Provider is not configured: openai-codex', 'auth'],
    ['mate is not signed in to ChatGPT', 'auth'],
    ["mate's ChatGPT sign-in stopped working", 'auth'],
    ['Request timed out', 'timeout'],
    ['model is not supported', 'other'],
    [
      "ChatGPT's usage limit is reached; opencode-go/qwen3.8-max: Request timed out",
      'timeout',
    ],
    [
      "mate's ChatGPT sign-in stopped working; opencode-go/qwen3.8-max: 500 server error",
      'other',
    ],
  ])('%p is %s', (message, kind) => {
    expect(providerErrorKind(message)).toBe(kind as never);
  });
});
