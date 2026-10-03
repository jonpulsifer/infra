/**
 * `bun run smoke` runs one turn through mate on a surface that lives in this
 * process: it mentions mate once as the owner and prints what comes back. The
 * model reads a file in a fresh sandbox, and the sandbox goes. With
 * `-- --kill` it deletes the Sandbox after the first tool call ends; the turn
 * should still finish, with the next tool call failing or reminting. It
 * answers on the fallback model, so it never holds the ChatGPT sign-in the
 * running mate refreshes.
 */
import {
  clampThinkingLevel,
  createModels,
  type ModelThinkingLevel as ThinkingLevel,
} from '@earendil-works/pi-ai';
import { systemClock } from './clock.ts';
import {
  type BrainConfig,
  type Config,
  ConfigError,
  readBrainConfig,
  readSandboxConfig,
} from './config.ts';
import { discoverKube, Kube, type KubeList } from './kube.ts';
import { type HandsConnectSample, SANDBOX_CARD_ID } from './lease.ts';
import { jsonLog, plain } from './log.ts';
import { Mate } from './mate.ts';
import {
  type Instruments,
  lazyInstruments,
  type TurnEnd,
  type TurnSample,
} from './metrics.ts';
import { CHATGPT_PROVIDER, defaultProviders } from './model.ts';
import {
  GUILD_LABEL,
  resolvePod,
  SANDBOX_API,
  type Sandbox,
  THREAD_LABEL,
  waitForPodGone,
} from './sandboxes.ts';
import { openDatabase } from './store.ts';
import type {
  Canvas,
  HistoryMessage,
  Inbound,
  Inbox,
  Notice,
  Outcome,
  Surface,
  SurfaceListener,
  ThreadRef,
  ToolCall,
} from './surface.ts';

const PROMPT =
  'Read AGENTS.md and reply with the file:line of the rule about `tofu apply`';
const STORE_WAIT_MS = 30_000;
const KILL_FALLBACK_MS = 120_000;
// A turn refused before it starts never ends; the lines it posts say why.
const TURN_SLACK_MS = 60_000;
// The running mate shares the cluster: its hands list only its own guild's
// sandboxes, so this label keeps each mate's hands off the other's.
const GUILD = 'smoke';
const ME = 'mate-smoke';
const OWNER = 'smoke';
const CHANNEL =
  process.env.MATE_ALLOWED_CHANNEL_IDS?.split(',')[0]?.trim() || '0';

/** The model that answers when ChatGPT cannot, as the only model. */
function answeringModel(
  brain: BrainConfig,
): Pick<
  BrainConfig,
  'model' | 'thinking' | 'fallbackModel' | 'fallbackThinking'
> {
  const spec = brain.fallbackModel;
  if (!spec) {
    const { model, thinking } = brain;
    return { model, thinking, fallbackModel: null, fallbackThinking: null };
  }
  return {
    model: spec,
    thinking: brain.fallbackThinking ?? nearestLevel(spec, brain.thinking),
    fallbackModel: null,
    fallbackThinking: null,
  };
}

// The level mate's router gives the fallback; mate refuses an unknown model.
function nearestLevel(spec: string, level: ThinkingLevel): ThinkingLevel {
  const models = createModels();
  for (const provider of defaultProviders()) models.setProvider(provider);
  const slash = spec.indexOf('/');
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  return model ? clampThinkingLevel(model, level) : level;
}

function smokeConfig(env: Record<string, string | undefined>): Config {
  const sandbox = readSandboxConfig(env);
  const brain = readBrainConfig(env);
  if (!env.MATE_MODEL_KEY_FILE?.trim()) {
    throw new ConfigError('MATE_MODEL_KEY_FILE is required');
  }
  if (!brain.databaseUrl) {
    throw new ConfigError(
      'DATABASE_URL is required: mate keeps no session without mate-db',
    );
  }
  const answering = answeringModel(brain);
  // A second holder of the ChatGPT refresh token could spend it under mate.
  if (answering.model.startsWith(`${CHATGPT_PROVIDER}/`)) {
    throw new ConfigError(
      `smoke answers on the fallback model, never on ChatGPT; got ${answering.model}`,
    );
  }
  return {
    token: '',
    guildId: GUILD,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
    quietMs: 30 * 60_000,
    maxTurnsPerThread: 1,
    maxTurnsPerDay: 1,
    maxConcurrent: 1,
    maxSandboxes: 1,
    port: 0,
    sessionFile: null,
    // A fresh sandbox every run, and no kthx sites ledger, whose Secret is the
    // running mate's.
    sandbox: { ...sandbox, spares: 0, kthx: { ...sandbox.kthx, origin: null } },
    // The retention sweep is the running mate's to run.
    brain: {
      ...brain,
      ...answering,
      mcpServers: [],
      sessionRetentionDays: 0,
    },
    githubApp: null,
    sshKeyFile: null,
    talosconfigFile: null,
    slack: null,
    custodianChannel: null,
  };
}

/** Prints the thread to the terminal and times what mate draws in it. */
class Terminal implements Surface {
  readonly name = 'discord';
  readonly me = ME;
  readonly allowedUserIds = new Set([OWNER]);
  readonly allowedChannelIds = new Set([CHANNEL]);
  inbox: Inbox | null = null;
  readonly listener: SurfaceListener = {
    start: async (threads) => {
      // mate-db holds the running mate's threads, which are not this
      // process's to open.
      await threads.add(this, { rehydrate: false });
      this.inbox = threads;
    },
    stop: () => {},
    close: async () => {},
  };
  thread: ThreadRef | null = null;
  firstToolAt: number | null = null;
  toolEndedAt: number | null = null;
  readyAt: number | null = null;
  finalAt: number | null = null;
  text = '';
  private printed = 0;
  private status: string | null = null;
  private ended: (outcome: Outcome) => void = () => {};
  readonly final = new Promise<Outcome>((resolve) => {
    this.ended = resolve;
  });

  async openThread(message: Inbound): Promise<ThreadRef> {
    this.thread = {
      surface: this.name,
      channelId: message.channelId,
      id: message.id,
    };
    return this.thread;
  }

  async post(_: ThreadRef, text: string): Promise<void> {
    process.stderr.write(`\n[mate: ${text}]\n`);
  }

  notice(thread: ThreadRef): Notice {
    return {
      say: (text) => this.post(thread, text),
      done: async (text) => {
        if (text) await this.post(thread, text);
      },
    };
  }

  async history(): Promise<HistoryMessage[]> {
    return [];
  }

  canvas(): Canvas {
    return {
      live: async (text, status) => {
        this.print(text);
        if (status && status !== this.status) {
          process.stderr.write(`\n[${status}]\n`);
        }
        this.status = status;
      },
      final: async (text, outcome) => {
        this.print(text);
        process.stdout.write('\n');
        this.finalAt ??= Date.now();
        this.text = text;
        this.ended(outcome);
      },
      tool: async (call) => this.tool(call),
      step: async (text) => {
        process.stdout.write(`${text}\n`);
      },
    };
  }

  private tool({ id, title, state }: ToolCall): void {
    if (id === SANDBOX_CARD_ID) {
      if (state === 'complete') this.readyAt ??= Date.now();
    } else {
      this.firstToolAt ??= Date.now();
      if (state !== 'in_progress') this.toolEndedAt ??= Date.now();
    }
    process.stderr.write(`\n[${title}: ${state}]\n`);
  }

  private print(text: string): void {
    if (text.length < this.printed) this.printed = 0;
    process.stdout.write(text.slice(this.printed));
    this.printed = text.length;
  }
}

function seconds(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(2)}s`;
}

function report(rows: [string, number | null | undefined][]): void {
  const width = Math.max(...rows.map(([label]) => label.length));
  process.stderr.write('\n');
  for (const [label, ms] of rows) {
    process.stderr.write(`${label.padEnd(width)}  ${seconds(ms)}\n`);
  }
}

function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const kill = process.argv.includes('--kill');
let config: Config;
try {
  config = smokeConfig(process.env);
} catch (error) {
  jsonLog.error('config error', { error: plain(error) });
  process.exit(64);
}

const kubeConfig = await discoverKube();
const kube = new Kube(kubeConfig);
const namespace = config.sandbox.namespace ?? kube.namespace;
const sandboxes = `/apis/${SANDBOX_API}/namespaces/${namespace}/sandboxes`;

async function sandboxOf(thread: ThreadRef): Promise<Sandbox | null> {
  const list = await kube.json<KubeList<Sandbox>>(sandboxes, {
    query: {
      labelSelector: `${GUILD_LABEL}=${GUILD},${THREAD_LABEL}=${thread.id}`,
    },
  });
  return list.items[0] ?? null;
}

async function deleteSandbox(thread: ThreadRef): Promise<void> {
  const sandbox = await sandboxOf(thread);
  if (!sandbox) return;
  const name = sandbox.metadata.name;
  jsonLog.warn('deleting the sandbox mid-turn', { sandbox: name });
  const response = await kube.request(`${sandboxes}/${name}`, {
    method: 'DELETE',
  });
  await response.body?.cancel().catch(() => {});
}

async function podOf(thread: ThreadRef): Promise<string | null> {
  try {
    const sandbox = await sandboxOf(thread);
    return sandbox ? await resolvePod(kube, namespace, sandbox) : null;
  } catch {
    return null;
  }
}

const database = await openDatabase(config.brain, jsonLog);
if (!database.sql || (await within(database.ready, STORE_WAIT_MS)) === null) {
  jsonLog.error('smoke failed', { error: 'mate-db did not come up' });
  await database.close().catch(() => {});
  process.exit(1);
}

const recorded: {
  connect: HandsConnectSample | null;
  ended: { reason: TurnEnd; sample: TurnSample } | null;
} = { connect: null, ended: null };
const metrics: Instruments = {
  ...lazyInstruments(),
  handsConnected: (_, sample) => {
    recorded.connect ??= sample;
  },
  turnEnded: (reason, sample) => {
    recorded.ended ??= { reason, sample };
  },
};

const terminal = new Terminal();
const mate = new Mate({
  config,
  clock: systemClock,
  log: jsonLog,
  metrics,
  kube: kubeConfig,
  database,
  surfaces: { discord: terminal.listener, slack: null },
});

// Forgetting the thread releases its sandbox and deletes its session and row:
// the running mate resumes a marked turn it finds at its next boot.
async function forget(): Promise<void> {
  const { thread, inbox } = terminal;
  if (!thread || !inbox) return;
  await inbox.onThreadDeleted(thread).catch((error) =>
    jsonLog.warn('the smoke thread could not be deleted', {
      error: plain(error),
    }),
  );
}

let interrupted = false;
async function interrupt(signal: string): Promise<void> {
  if (interrupted) return;
  interrupted = true;
  jsonLog.warn('smoke interrupted', { signal });
  await forget();
  await mate.stop();
  process.exit(1);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void interrupt(signal));
}

try {
  await mate.start();
} catch (error) {
  await database.close().catch(() => {});
  const bad = error instanceof ConfigError;
  jsonLog.error(bad ? 'config error' : 'smoke failed', { error: plain(error) });
  process.exit(bad ? 64 : 1);
}

const id = `${Date.now()}${Math.floor(Math.random() * 10_000)
  .toString()
  .padStart(4, '0')}`;
let failed = false;
let deleted = false;
try {
  const threads = terminal.inbox;
  if (!threads) throw new Error('mate did not start the smoke surface');
  jsonLog.info('smoke starting', {
    namespace,
    image: config.sandbox.image,
    model: config.brain.model,
    thinking: config.brain.thinking,
    thread: id,
    mode: kill ? 'kill-mid-turn' : 'round-trip',
  });
  const promptedAt = Date.now();
  void threads
    .onMessage({
      surface: terminal.name,
      id,
      channelId: CHANNEL,
      threadId: null,
      authorId: OWNER,
      authorIsBot: false,
      content: `<@${ME}> ${PROMPT}`,
      mentionsMe: true,
    })
    .catch((error) =>
      jsonLog.error('the mention failed', { error: plain(error) }),
    );
  let killed = false;
  const killNow = () => {
    const thread = terminal.thread;
    if (killed || !thread) return;
    killed = true;
    void deleteSandbox(thread).catch((error) =>
      jsonLog.warn('the sandbox could not be deleted', {
        error: plain(error),
      }),
    );
  };
  const armed = kill
    ? setInterval(() => {
        if (terminal.toolEndedAt) killNow();
      }, 250)
    : null;
  const fallback = kill
    ? setTimeout(() => {
        if (terminal.readyAt) killNow();
      }, KILL_FALLBACK_MS)
    : null;
  const outcome = await within(
    terminal.final,
    config.sandbox.turnTimeoutMs + TURN_SLACK_MS,
  );
  if (armed) clearInterval(armed);
  if (fallback) clearTimeout(fallback);
  const result = recorded.ended;
  const reason = result?.reason ?? null;
  jsonLog.info('turn ended', {
    stopReason: reason,
    outcome,
    costUsd: result?.sample.costUsd ?? null,
    chars: terminal.text.length,
    killedMidTurn: killed,
  });
  failed = kill
    ? reason === null || reason === 'error' || reason === 'brain-failed'
    : reason !== 'end_turn';

  const thread = terminal.thread;
  if (thread) {
    const pod = killed ? null : await podOf(thread);
    await threads.onThreadDeleted(thread);
    deleted = true;
    if (pod) await waitForPodGone(kube, namespace, pod);
  }
  report([
    ['prompt → first token', result?.sample.firstTokenMs],
    [
      'first tool → sandbox ready',
      terminal.readyAt && terminal.firstToolAt
        ? terminal.readyAt - terminal.firstToolAt
        : null,
    ],
    ['hands connect', recorded.connect?.connectMs],
    [
      'prompt → final',
      terminal.finalAt === null ? null : terminal.finalAt - promptedAt,
    ],
  ]);
} catch (error) {
  failed = true;
  jsonLog.error('smoke failed', { error: plain(error) });
} finally {
  if (!deleted) await forget();
  await mate.stop();
}

process.exitCode = failed ? 1 : 0;
