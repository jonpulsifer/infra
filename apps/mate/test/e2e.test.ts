/**
 * mate end to end: the thread engine drives the pi brain on pi-ai's faux
 * model, which keeps its sessions in Postgres and reaches sandboxes through
 * the kube hands on a fake apiserver whose pods run the real mate-hands
 * daemon.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentMessage,
  BACKGROUND_CONTEXT,
} from '@earendil-works/pi-agent-core';
import { createModels, type Message } from '@earendil-works/pi-ai';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { openSession } from '@repo/pi-store-postgres';
import { PiBrain, postgresSessions } from '../src/brain.ts';
import type {
  McpBridge,
  ModelSetup,
  ProfilePrompts,
} from '../src/brain-inputs.ts';
import {
  type BrainSession,
  TurnAbandoned,
  type TurnContext,
} from '../src/brain-port.ts';
import { type Clock, type Handle, systemClock } from '../src/clock.ts';
import { HANDS_BINARY } from '../src/hands.ts';
import { KthxSites, serialize } from '../src/kthx-sites.ts';
import { combineMcp, createMcpBridge } from '../src/mcp.ts';
import { HARNESS_FAILED, RESUMING, RUNS_AS } from '../src/notices.ts';
import { brainProfiles } from '../src/profile.ts';
import { PROFILES } from '../src/profiles.ts';
import type { PromptResult, PromptSink } from '../src/sandbox.ts';
import {
  CHECKOUT_LABEL,
  type KubeHands,
  sandboxName,
  sandboxNameFor,
} from '../src/sandboxes.ts';
import { PostgresThreadStore } from '../src/store.ts';
import {
  type Inbound,
  type Surface,
  type ThreadRef,
  threadKey,
} from '../src/surface.ts';
import type { ThreadRow } from '../src/thread-store.ts';
import { Threads } from '../src/threads.ts';
import { withDatabase } from './db.ts';
import { FakeMcp } from './fake-mcp.ts';
import type { ExecRecord } from './fakeapi.ts';
import {
  alive,
  cleanUp,
  FakeApp,
  INVESTIGATOR,
  pidsIn,
  rig,
  until,
} from './hands-support.ts';
import {
  discordRef,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
} from './support.ts';

const database = withDatabase();
const ctx = BACKGROUND_CONTEXT;
const ME = '900000000000000001';
const OWNER = '308072071949320204';
const CHANNEL = '1509024937422356532';
const INTERRUPTED = 'Tool execution was interrupted';
const TOKEN = 'kthx_agent_0123456789abcdef0123456789abcdef';
// Every e2e test runs real daemons, Postgres and several turns.
const SLOW = 30_000;
const PROMPTS: ProfilePrompts = Object.fromEntries(
  [...PROFILES.keys()].map((id) => [
    id,
    { discord: 'You help on Discord.', slack: 'You help on Slack.' },
  ]),
);

/** Real time, with every timer it armed cancelled at the end of a test. */
class RealClock implements Clock {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  after(ms: number, fn: () => void): Handle {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  cancel(handle: Handle): void {
    const timer = handle as ReturnType<typeof setTimeout>;
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return systemClock.sleep(ms, signal);
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

let snowflake = 1509024937422357000n;

/** Discord whose threads get snowflake ids, which a Sandbox's name is built from. */
class SnowflakeDiscord extends FakeDiscord {
  override async createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string> {
    snowflake += 1n;
    const id = String(snowflake);
    this.threads.push({ channelId, messageId, name, id });
    return id;
  }
}

/** PiBrain as it is, with what each prompt and resume settled to. */
class WatchedBrain extends PiBrain {
  readonly outcomes: (PromptResult | unknown)[] = [];

  override async prompt(
    session: BrainSession,
    text: string,
    sink: PromptSink,
    turn: TurnContext,
  ): Promise<PromptResult> {
    return this.watch(super.prompt(session, text, sink, turn));
  }

  override async resume(
    session: BrainSession,
    sink: PromptSink,
    turn: TurnContext,
  ): Promise<PromptResult> {
    return this.watch(super.resume(session, sink, turn));
  }

  private async watch(running: Promise<PromptResult>): Promise<PromptResult> {
    try {
      const result = await running;
      this.outcomes.push(result);
      return result;
    } catch (error) {
      this.outcomes.push(error);
      throw error;
    }
  }
}

function faux(...steps: FauxResponseStep[]): ModelSetup {
  const provider = fauxProvider({
    api: 'faux',
    provider: 'faux',
    tokenSize: { min: 3, max: 3 },
    models: [{ id: 'faux', reasoning: true }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const model = provider.getModel('faux');
  if (!model) throw new Error('no faux model');
  provider.setResponses(steps);
  return { models, direct: models, model, thinking: 'off', router: null };
}

const tool = (
  name: string,
  args: Parameters<typeof fauxToolCall>[1],
  id: string,
) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: 'toolUse',
  });

/** One mate process: its engine, brain and hands over a shared cluster and database. */
interface Mate {
  readonly threads: Threads;
  readonly brain: WatchedBrain;
  readonly hands: KubeHands;
  readonly store: PostgresThreadStore;
  readonly surface: Surface;
  readonly clock: RealClock;
  readonly log: RecordingLog;
  readonly metrics: RecordingInstruments;
}

const mates: Mate[] = [];
const servers: FakeMcp[] = [];
const bridges: McpBridge[] = [];

afterEach(async () => {
  for (const mate of mates.splice(0)) mate.clock.stop();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await cleanUp();
});

async function boot(
  discord: FakeDiscord,
  hands: KubeHands,
  setup: ModelSetup,
  mcp: McpBridge | null = null,
): Promise<Mate> {
  const { sql } = database();
  const clock = new RealClock();
  const log = new RecordingLog();
  const metrics = new RecordingInstruments();
  const store = new PostgresThreadStore(sql);
  const surface = discord.surface({
    me: ME,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
    clock,
  });
  const brain = new WatchedBrain({
    db: { up: () => true },
    store,
    sessions: postgresSessions(sql),
    hands,
    setup,
    profiles: brainProfiles(setup, PROMPTS, 60_000),
    mcp,
    log,
    metrics,
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    timeouts: { mcpBootWait: 2_000 },
  });
  const threads = new Threads({
    surfaces: [],
    brain,
    store,
    storeReady: Promise.resolve(),
    inherited: await hands.start(),
    clock,
    log,
    config: {
      quietMs: 3_600_000,
      maxTurnsPerThread: 30,
      maxTurnsPerDay: 120,
      maxConcurrent: 3,
    },
    editCadenceMs: 20,
    runGraceMs: 20,
    metrics,
  });
  await threads.add(surface);
  const mate = { threads, brain, hands, store, surface, clock, log, metrics };
  mates.push(mate);
  return mate;
}

/** SIGTERM as main runs it, with no time left for turns to finish. */
async function sigterm(mate: Mate): Promise<void> {
  await mate.threads.drain(0);
  await mate.hands.shutdown();
}

let serial = 0;

function mention(content: string): Inbound {
  return {
    surface: 'discord',
    id: `m-${++serial}`,
    channelId: CHANNEL,
    threadId: CHANNEL,
    authorId: OWNER,
    authorIsBot: false,
    content: `<@${ME}> ${content}`,
    mentionsMe: true,
  };
}

function inThread(
  discord: FakeDiscord,
  threadId: string,
  content: string,
): Inbound {
  discord.post(threadId, content, OWNER);
  return {
    surface: 'discord',
    id: `m-${++serial}`,
    channelId: threadId,
    threadId,
    authorId: OWNER,
    authorIsBot: false,
    content,
    mentionsMe: false,
  };
}

/** Starts a thread with `message` and returns where it lives. */
async function start(mate: Mate, discord: FakeDiscord, message: Inbound) {
  const before = discord.threads.length;
  await mate.threads.onMessage(message);
  const threadId = discord.threads[before]?.id;
  if (!threadId) throw new Error('no thread was opened');
  const ref: ThreadRef = discordRef(threadId, CHANNEL);
  return { threadId, ref, key: threadKey(ref) };
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = 10_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function row(mate: Mate, key: string): Promise<ThreadRow> {
  const found = await mate.store.get(key);
  if (!found) throw new Error(`no row for ${key}`);
  return found;
}

/** The turn and every write after it are done. */
async function settled(mate: Mate, key: string): Promise<void> {
  await eventually(
    async () =>
      mate.threads.stateOf(key) === 'idle' &&
      (await row(mate, key)).turn === null,
    `${key} to settle`,
  );
}

/** What the thread shows, message by message. */
function shown(discord: FakeDiscord, threadId: string) {
  return discord.inThread(threadId).map((message) => ({
    id: message.id,
    content: message.content,
    subtext: [...message.subtext],
    hasStop: message.hasStop,
    edits: message.edits,
  }));
}

/** The JSON-RPC methods mate wrote to one mate-hands exec, in order. */
function methods(exec: ExecRecord): string[] {
  return exec.stdin.map(
    (line) => (JSON.parse(line) as { method?: string }).method ?? '',
  );
}

function epochOf(exec: ExecRecord): number {
  return Number(exec.command[exec.command.indexOf('--epoch') + 1]);
}

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

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('a turn', () => {
  test(
    'a chat-only turn answers and creates no Sandbox',
    async () => {
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(
        discord,
        r.hands,
        faux(fauxAssistantMessage('hello there')),
      );
      const message = mention('hi');
      const { threadId, key } = await start(mate, discord, message);
      await settled(mate, key);

      expect(discord.contentsIn(threadId).at(-1)).toBe('hello there');
      expect(discord.reactionsOn(CHANNEL, message.id)).toEqual(['✅']);
      expect(r.fake.sandboxes.size).toBe(0);
      expect(r.fake.execs).toEqual([]);
      expect(
        r.fake.requests.filter((request) => request.method === 'POST'),
      ).toEqual([]);
      expect(r.metrics.turnSandboxes).toEqual(['none']);
    },
    SLOW,
  );

  test(
    'a tool turn creates one Sandbox and one hands exec, and leaves each stamped file blank at 0600',
    async () => {
      const app = new FakeApp();
      const r = rig({
        config: { github: true, kubeServiceAccount: 'mate-sandbox-admin' },
        deps: { githubApp: app, sshKey: 'PRIVATE-KEY-BYTES' },
      });
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(
        discord,
        r.hands,
        faux(
          tool('bash', { command: 'cat ~/.github-token' }, 'c-cat'),
          fauxAssistantMessage('the token is there'),
        ),
      );
      const message = mention('check the token');
      const { threadId, key } = await start(mate, discord, message);
      await settled(mate, key);

      expect(discord.contentsIn(threadId).at(-1)).toBe('the token is there');
      expect(discord.reactionsOn(CHANNEL, message.id)).toEqual(['✅']);
      expect(r.fake.sandboxes.size).toBe(1);
      expect(r.fake.handsExecs).toHaveLength(1);
      const [name] = [...r.fake.sandboxes.keys()];
      expect((await row(mate, key)).sandbox).toBe(name ?? null);
      // The command saw the token the turn stamped.
      const said = await transcript((await row(mate, key)).sessionId);
      expect(toolText(said, 'c-cat')).toContain('ghs-token-1');

      for (const file of [
        '.github-token',
        '.kube/config',
        '.ssh/id_ed25519',
        '.ssh/config',
      ]) {
        const path = join(r.home, file);
        expect(readFileSync(path, 'utf8')).toBe('');
        expect(mode(path)).toBe(0o600);
      }
      expect(app.revoked).toEqual(['ghs-token-1']);
      expect(r.metrics.turnSandboxes).toEqual(['fresh']);
    },
    SLOW,
  );
});

describe('a restart mid-turn', () => {
  test(
    'SIGTERM mid-bash leaves the turn for the next mate, which resumes it with the command interrupted',
    async () => {
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const pidFile = join(r.workspace, 'sleep.pid');
      const first = await boot(
        discord,
        r.hands,
        faux(
          tool(
            'bash',
            { command: 'echo $$ > sleep.pid; exec sleep 300' },
            'c-sleep',
          ),
        ),
      );
      const message = mention('run the long job');
      const { threadId, key } = await start(first, discord, message);
      const [pid] = await pidsIn(pidFile, 1);
      if (pid === undefined) throw new Error('no sleep pid');
      await eventually(
        () =>
          shown(discord, threadId).some((m) =>
            m.subtext.some((line) => line.includes('sleep 300')),
          ),
        'the bash card',
      );
      // Past the edit cadence, so no repaint is still due.
      await Bun.sleep(200);
      const card = shown(discord, threadId);

      await sigterm(first);
      await Bun.sleep(200);

      expect(first.brain.outcomes).toHaveLength(1);
      expect(first.brain.outcomes[0]).toBeInstanceOf(TurnAbandoned);
      // Nothing posted, and the card keeps its partial state and Stop button.
      expect(shown(discord, threadId)).toEqual(card);
      expect(card.at(-1)?.hasStop).toBe(true);
      expect(discord.reactionsOn(CHANNEL, message.id)).toEqual(['👀']);
      expect((await row(first, key)).turn).toMatchObject({
        asker: OWNER,
        message: { channelId: CHANNEL, id: message.id },
        resumes: 0,
      });
      // The daemon was told to cancel before the link closed, and nothing
      // reconnected once the lease was abandoned.
      expect(r.fake.handsExecs).toHaveLength(1);
      const link = r.fake.handsExecs[0] as ExecRecord;
      const sent = methods(link);
      expect(sent).toContain('cancel');
      expect(sent.indexOf('cancel')).toBeLessThan(sent.indexOf('shutdown'));
      expect(link.clientClosed).toBe(true);

      const second = await boot(
        discord,
        r.another(),
        faux(fauxAssistantMessage('picked it back up')),
      );
      await settled(second, key);

      const said = discord.contentsIn(threadId);
      expect(said.slice(card.length)).toEqual([RESUMING, 'picked it back up']);
      expect(discord.reactionsOn(CHANNEL, message.id)).toEqual(['✅']);
      expect(second.brain.outcomes).toEqual([
        expect.objectContaining({ stopReason: 'end_turn' }),
      ]);
      expect(second.metrics.resumes).toEqual(['resumed']);
      expect((await row(second, key)).turn).toBeNull();
      // The new mate reconnected with a newer epoch, and no sleep survived.
      expect(r.fake.handsExecs).toHaveLength(2);
      const [old, fresh] = r.fake.handsExecs as [ExecRecord, ExecRecord];
      expect(fresh.pod).toBe(old.pod);
      expect(epochOf(fresh)).toBeGreaterThan(epochOf(old));
      await until(() => !alive(pid));
      const stored = await transcript((await row(second, key)).sessionId);
      expect(toolText(stored, 'c-sleep')).toContain(INTERRUPTED);
    },
    SLOW,
  );

  test(
    'a resume while the MCP bridge lists nothing completes',
    async () => {
      const r = rig();
      const discord = new SnowflakeDiscord(ME);
      const held = gate();
      const deploy = new FakeMcp({
        tools: [
          {
            name: 'deploy',
            description: 'Deploys an app',
            inputSchema: {
              type: 'object',
              properties: { app: { type: 'string' } },
              required: ['app'],
            },
          },
        ],
      }).start();
      servers.push(deploy);
      deploy.handlers.set('deploy', async () => {
        await held.wait;
        return { content: [{ type: 'text', text: 'too late' }] };
      });
      const listing = createMcpBridge({
        name: 'kthx',
        prefix: 'kthx_',
        url: deploy.url,
        token: TOKEN,
        log: new RecordingLog(),
      });
      bridges.push(listing);
      listing.start();
      expect(await listing.ready(5_000)).toBe(true);
      const first = await boot(
        discord,
        r.hands,
        faux(tool('kthx_deploy', { app: 'wishin' }, 'c-kthx')),
        listing,
      );
      const message = mention('deploy wishin');
      const { threadId, key } = await start(first, discord, message);
      await eventually(
        () => deploy.calls('tools/call').length === 1,
        'the kthx call',
      );
      await sigterm(first);
      await listing.close();
      held.open();

      const empty = new FakeMcp({ tools: [] }).start();
      servers.push(empty);
      const bare = createMcpBridge({
        name: 'kthx',
        prefix: 'kthx_',
        url: empty.url,
        token: TOKEN,
        log: new RecordingLog(),
      });
      bridges.push(bare);
      bare.start();
      const second = await boot(
        discord,
        r.another(),
        faux(fauxAssistantMessage('kthx went quiet; try again later')),
        bare,
      );
      await settled(second, key);

      expect(second.brain.outcomes).toEqual([
        expect.objectContaining({ stopReason: 'end_turn' }),
      ]);
      const said = discord.contentsIn(threadId);
      expect(said).toContain(RESUMING);
      expect(said.at(-1)).toBe('kthx went quiet; try again later');
      expect(said.some((line) => line.startsWith(HARNESS_FAILED))).toBe(false);
      expect(
        JSON.stringify([...second.log.entries, ...said]).includes(
          'configured_tools_unavailable',
        ),
      ).toBe(false);
      expect(discord.reactionsOn(CHANNEL, message.id)).toEqual(['✅']);
      const stored = await transcript((await row(second, key)).sessionId);
      expect(toolText(stored, 'c-kthx')).toContain(INTERRUPTED);
      // The turn never needed a sandbox.
      expect(r.fake.sandboxes.size).toBe(0);
    },
    SLOW,
  );
});

describe('Stop', () => {
  test(
    'during a mint ends the turn at once; the mint lands against the thread, and its next turn reuses it',
    async () => {
      const r = rig();
      r.fake.readyOnCreate = false;
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(
        discord,
        r.hands,
        faux(
          tool('bash', { command: 'true' }, 'c-first'),
          tool('bash', { command: 'echo again' }, 'c-again'),
          fauxAssistantMessage('ran it again'),
        ),
      );
      const message = mention('run it');
      const { threadId, key } = await start(mate, discord, message);
      await eventually(() => r.fake.sandboxes.size === 1, 'the mint');
      const [name] = [...r.fake.sandboxes.keys()] as [string];

      await mate.threads.onStop(key, OWNER, async () => {});
      // Well inside the rig's 4 s wait for Ready: Stop never waits out a mint.
      await eventually(
        async () =>
          mate.threads.stateOf(key) === 'idle' &&
          (await row(mate, key)).turn === null,
        'the stopped turn',
        2_000,
      );
      expect(mate.brain.outcomes).toEqual([
        expect.objectContaining({ stopReason: 'cancelled' }),
      ]);
      await eventually(
        () => discord.reactionsOn(CHANNEL, message.id).includes('⏹️'),
        'the stopped mark',
      );
      expect(r.fake.handsExecs).toEqual([]);

      r.fake.markReady(name);
      await eventually(
        async () => (await row(mate, key)).sandbox === name,
        'the mint to land against the thread',
      );

      const again = inThread(discord, threadId, 'try again');
      await mate.threads.onMessage(again);
      await eventually(
        () => discord.reactionsOn(threadId, again.id).includes('✅'),
        'the second turn',
      );
      await settled(mate, key);
      expect(discord.contentsIn(threadId).at(-1)).toBe('ran it again');
      expect(r.fake.sandboxes.size).toBe(1);
      expect(
        r.fake.requests.filter(
          (request) =>
            request.method === 'POST' && request.path.endsWith('/sandboxes'),
        ),
      ).toHaveLength(1);
      expect(r.fake.handsExecs).toHaveLength(1);
      expect(r.fake.handsExecs[0]?.command[0]).toBe(HANDS_BINARY);
      expect(r.metrics.turnSandboxes).toEqual(['failed', 'reused']);
    },
    SLOW,
  );
});

describe('profiles', () => {
  const ORIGIN = 'https://kthx.example.test';
  const SITES_SECRET = 'mate-kthx-sites';
  const LEDGER = serialize({ [ORIGIN]: { blog: 'tok-blog' } });
  const BASE = ['bash', 'edit', 'read', 'write'];

  /** The tool names pi sent the model, replayed from the system messages in order. */
  function toolsHeard(messages: readonly Message[]): string[] {
    const tools = new Set<string>();
    for (const message of messages) {
      if (message.role !== 'system') continue;
      for (const added of message.toolsAdded ?? []) tools.add(added.name);
      for (const removed of message.toolsRemoved ?? []) {
        tools.delete(removed.name);
      }
    }
    return [...tools].sort();
  }

  function bridged(name: string, toolName: string): McpBridge {
    const server = new FakeMcp({
      tools: [
        {
          name: toolName,
          description: `${name} ${toolName}`,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }).start();
    servers.push(server);
    const bridge = createMcpBridge({
      name,
      prefix: `${name}_`,
      url: server.url,
      token: TOKEN,
      log: new RecordingLog(),
    });
    bridges.push(bridge);
    return bridge;
  }

  function envNames(sandbox: unknown): string[] {
    const spec = (sandbox as { spec: { podTemplate: { spec: unknown } } }).spec
      .podTemplate.spec as { containers: { env?: { name: string }[] }[] };
    return (spec.containers[0]?.env ?? []).map((entry) => entry.name);
  }

  function labelsOf(sandbox: unknown): Record<string, string> {
    return (sandbox as { metadata: { labels: Record<string, string> } })
      .metadata.labels;
  }

  test(
    'an investigator thread runs read-only, refuses another profile, and an operator thread mints its own sandbox',
    async () => {
      const app = new FakeApp();
      const r = rig({
        config: {
          github: true,
          kubeServiceAccount: 'mate-sandbox-admin',
          kubeReaderServiceAccount: 'mate-sandbox-reader',
          kthx: { origin: ORIGIN, sitesSecret: SITES_SECRET },
        },
        deps: { githubApp: app, sshKey: 'PRIVATE-KEY-BYTES' },
      });
      r.fake.putSecret(SITES_SECRET, { 'sites.json': LEDGER });
      r.hands = r.another({
        kthxSites: new KthxSites({
          kube: r.kube,
          namespace: 'mate',
          secret: SITES_SECRET,
          log: r.log,
        }),
      });
      const mcp = combineMcp([
        bridged('kthx', 'deploy'),
        bridged('weather', 'now'),
      ]);
      mcp.start();
      expect(await mcp.ready(5_000)).toBe(true);
      const heard: string[][] = [];
      const discord = new SnowflakeDiscord(ME);
      const mate = await boot(
        discord,
        r.hands,
        faux(
          (context) => {
            heard.push(toolsHeard(context.messages));
            return tool(
              'bash',
              {
                command:
                  'env; cat ~/.github-token ~/.kube/config ~/.ssh/id_ed25519 ~/.config/kthx/sites.json',
              },
              'c-look',
            );
          },
          fauxAssistantMessage('nothing to see'),
          (context) => {
            heard.push(toolsHeard(context.messages));
            return tool('bash', { command: 'true' }, 'c-fix');
          },
          fauxAssistantMessage('fixed'),
        ),
        mcp,
      );

      const look = mention('+investigator check');
      const investigating = await start(mate, discord, look);
      await settled(mate, investigating.key);

      expect(discord.contentsIn(investigating.threadId)).toEqual([
        `${RUNS_AS} investigator`,
        'nothing to see',
      ]);
      expect(discord.reactionsOn(CHANNEL, look.id)).toEqual(['✅']);
      expect((await row(mate, investigating.key)).profile).toBe('investigator');
      const readerName = sandboxNameFor(investigating.ref, INVESTIGATOR);
      expect(readerName).toBe(`${sandboxName(investigating.ref)}-r`);
      expect([...r.fake.sandboxes.keys()]).toEqual([readerName]);
      const readerSandbox = r.fake.sandboxes.get(readerName);
      expect(labelsOf(readerSandbox)).toMatchObject({
        'app.kubernetes.io/name': 'mate-sandbox-reader',
        'lolwtf.ca/minted-by': 'mate-reader',
        'lolwtf.ca/profile': 'investigator',
      });
      const env = envNames(readerSandbox);
      expect(env).toContain('KUBECONFIG');
      for (const name of env) {
        expect(name).not.toMatch(
          /^(SWITCHBOARD_|OP_|KTHX_ORIGIN$|MATE_GITHUB_TOKEN_FILE$)/,
        );
      }
      // The window was shut before mate ran anything in the pod.
      const readerExecs = r.fake.execs.filter((e) => e.pod === readerName);
      expect(readerExecs[0]?.command[0]).toBe(HANDS_BINARY);
      for (const exec of readerExecs) {
        expect(exec.podLabels[CHECKOUT_LABEL]).toBe('closed');
      }
      expect(r.fake.tokenRequests).toEqual([
        {
          account: 'mate-sandbox-reader',
          expirationSeconds: 1500,
          audiences: expect.any(Array),
        },
      ]);
      expect(app.asked).toBe(0);
      expect(app.minted).toBe(0);
      const said = toolText(
        await transcript((await row(mate, investigating.key)).sessionId),
        'c-look',
      );
      // The command ran with the reader's kubeconfig and nothing else.
      expect(said).toContain('sa-token-1');
      expect(said).not.toContain('ghs-token');
      expect(said).not.toContain('PRIVATE-KEY-BYTES');
      expect(said).not.toContain('tok-blog');
      for (const file of ['.github-token', '.ssh/id_ed25519', '.ssh/config']) {
        expect(readFileSync(join(r.home, file), 'utf8')).toBe('');
      }
      expect(existsSync(join(r.home, '.config/kthx/sites.json'))).toBe(false);
      expect(r.fake.patches.filter((p) => p.name === SITES_SECRET)).toEqual([]);
      expect(r.fake.secretValue(SITES_SECRET, 'sites.json')).toBe(LEDGER);
      expect(heard[0]).toEqual([...BASE, 'weather_now'].sort());

      const fix = inThread(discord, investigating.threadId, '+operator do it');
      await mate.threads.onMessage(fix);
      await eventually(
        () => discord.reactionsOn(investigating.threadId, fix.id).length > 0,
        'the refusal',
      );
      expect(discord.contentsIn(investigating.threadId).at(-1)).toBe(
        `${RUNS_AS} investigator — a thread keeps the profile it opened with; start a new thread for +operator`,
      );
      expect(discord.reactionsOn(investigating.threadId, fix.id)).toEqual([
        '⚠️',
      ]);
      expect(heard).toHaveLength(1);

      const operating = await start(mate, discord, mention('fix it'));
      await settled(mate, operating.key);

      expect(discord.contentsIn(operating.threadId).at(-1)).toBe('fixed');
      expect((await row(mate, operating.key)).profile).toBe('operator');
      const operatorName = sandboxName(operating.ref);
      expect([...r.fake.sandboxes.keys()].sort()).toEqual(
        [operatorName, readerName].sort(),
      );
      expect(labelsOf(r.fake.sandboxes.get(operatorName))).toMatchObject({
        'app.kubernetes.io/name': 'mate-sandbox',
        'lolwtf.ca/minted-by': 'mate',
        'lolwtf.ca/profile': 'operator',
      });
      expect(r.fake.tokenRequests.map((t) => t.account)).toEqual([
        'mate-sandbox-reader',
        'mate-sandbox-admin',
      ]);
      expect(app.minted).toBe(1);
      expect(heard[1]).toEqual([...BASE, 'kthx_deploy', 'weather_now'].sort());
    },
    SLOW,
  );
});
