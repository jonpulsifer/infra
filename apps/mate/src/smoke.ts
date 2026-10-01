/**
 * `bun run smoke` runs one turn through the real brain and hands with no chat
 * surface: the model reads a file in a fresh sandbox, and the sandbox goes.
 * With `-- --kill` it deletes the Sandbox after the first tool call ends; the
 * turn should still finish, with the next tool call failing or reminting.
 */
import { fileURLToPath } from 'node:url';
import {
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
} from '@earendil-works/pi-agent-core';
import { PiBrain, postgresSessions, type SessionSource } from './brain.ts';
import { ConfigError, readBrainConfig, readSandboxConfig } from './config.ts';
import { discoverKube, Kube } from './kube.ts';
import type { Hands, HandsConnectSample, LeaseEvent } from './lease.ts';
import { WORKSPACE } from './lease.ts';
import { jsonLog, plain } from './log.ts';
import { lazyInstruments } from './metrics.ts';
import { createModelSetup } from './model.ts';
import { brainProfiles, loadSystemPrompts } from './profile.ts';
import { DEFAULT_PROFILE, PROFILES } from './profiles.ts';
import type { PromptSink, Update } from './sandbox.ts';
import {
  createKubeHands,
  resolvePod,
  type Sandbox,
  waitForPodGone,
} from './sandboxes.ts';
import {
  MemoryThreadStore,
  openDatabase,
  PostgresThreadStore,
} from './store.ts';
import { type ThreadRef, threadKey } from './surface.ts';
import type { ThreadStore } from './thread-store.ts';

const PROMPT =
  'Read AGENTS.md and reply with the file:line of the rule about `tofu apply`';
const STORE_WAIT_MS = 30_000;
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const KILL_FALLBACK_MS = 120_000;

const kill = process.argv.includes('--kill');
let sandbox: ReturnType<typeof readSandboxConfig>;
let brainConfig: ReturnType<typeof readBrainConfig>;
try {
  sandbox = readSandboxConfig(process.env);
  brainConfig = readBrainConfig(process.env);
  if (!process.env.MATE_MODEL_KEY_FILE?.trim()) {
    throw new ConfigError('MATE_MODEL_KEY_FILE is required');
  }
} catch (error) {
  jsonLog.error('config error', { error: plain(error) });
  process.exit(64);
}

const kube = new Kube(await discoverKube());
const namespace = sandbox.namespace ?? kube.namespace;
const guildId = process.env.MATE_GUILD_ID?.trim() || '0';
const thread: ThreadRef = {
  surface: 'discord',
  id: `${Date.now()}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`,
  channelId: process.env.MATE_ALLOWED_CHANNEL_IDS?.split(',')[0]?.trim() || '0',
};

let connect: HandsConnectSample | null = null;
const metrics = {
  ...lazyInstruments(),
  handsConnected: (_: string, sample: HandsConnectSample) => {
    connect ??= sample;
  },
};
const kubeHands = createKubeHands({
  kube,
  config: sandbox,
  guildId,
  maxSandboxes: 1,
  log: jsonLog,
  metrics,
});

let readyAt: number | null = null;
let readySandbox: string | null = null;
// The same hands, with the lease's ready event timed.
const hands: Hands = {
  thread: (ref, hooks, profile) => {
    const inner = kubeHands.thread(ref, hooks, profile);
    return {
      env: inner.env,
      beginTurn: (options) =>
        inner.beginTurn({
          ...options,
          onEvent: (event: LeaseEvent) => {
            if (event.kind === 'ready') {
              readyAt ??= Date.now();
              readySandbox = event.sandbox;
            }
            options.onEvent(event);
          },
        }),
    };
  },
  release: (ref, reason) => kubeHands.release(ref, reason),
  ensureSpares: () => kubeHands.ensureSpares(),
  start: () => kubeHands.start(),
  shutdown: () => kubeHands.shutdown(),
};

/** mate-db when `DATABASE_URL` is set, else a session that lives in this process. */
async function sessionStore(): Promise<{
  store: ThreadStore;
  sessions: SessionSource;
  close(): Promise<void>;
}> {
  if (!brainConfig.databaseUrl) {
    const repo = new MemorySessionRepo();
    return {
      store: new MemoryThreadStore(),
      sessions: {
        open: (id) => repo.create({ id }, BACKGROUND_CONTEXT),
        delete: async () => {},
      },
      close: async () => {},
    };
  }
  const db = await openDatabase(brainConfig, jsonLog);
  const up = await Promise.race([
    db.ready.then(() => true),
    Bun.sleep(STORE_WAIT_MS).then(() => false),
  ]);
  if (!up || !db.sql) throw new Error('mate-db did not come up');
  return {
    store: new PostgresThreadStore(db.sql),
    sessions: postgresSessions(db.sql),
    close: () => db.close(),
  };
}

class Streaming implements PromptSink {
  firstTextAt: number | null = null;
  firstToolAt: number | null = null;
  toolEndedAt: number | null = null;
  text = '';
  constructor(private readonly startedAt: number) {}
  update(update: Update): void {
    if (update.kind === 'status') {
      if (update.line) process.stderr.write(`\n[${update.line}]\n`);
      return;
    }
    if (update.kind === 'tool') {
      const { id, title, state } = update.call;
      if (id !== 'sandbox') {
        this.firstToolAt ??= Date.now();
        if (state !== 'in_progress') this.toolEndedAt ??= Date.now();
      }
      process.stderr.write(`\n[${title}: ${state}]\n`);
      return;
    }
    this.firstTextAt ??= Date.now() - this.startedAt;
    this.text += update.delta;
    process.stdout.write(update.delta);
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

async function deleteSandbox(name: string): Promise<void> {
  jsonLog.warn('deleting the sandbox mid-turn', { sandbox: name });
  const response = await kube.request(
    `/apis/agents.x-k8s.io/v1beta1/namespaces/${namespace}/sandboxes/${name}`,
    { method: 'DELETE' },
  );
  await response.body?.cancel().catch(() => {});
}

async function podOf(name: string): Promise<string | null> {
  try {
    const object = await kube.json<Sandbox>(
      `/apis/agents.x-k8s.io/v1beta1/namespaces/${namespace}/sandboxes/${name}`,
    );
    return await resolvePod(kube, namespace, object);
  } catch {
    return null;
  }
}

let failed = false;
const { store, sessions, close } = await sessionStore();
// No credential store: a second holder of the ChatGPT refresh token could
// spend it under mate, so a ChatGPT primary answers on the fallback here.
const setup = createModelSetup({
  spec: brainConfig.model,
  thinking: brainConfig.thinking,
  fallbackSpec: brainConfig.fallbackModel,
  fallbackThinking: brainConfig.fallbackThinking,
  keyFile: brainConfig.modelKeyFile,
  log: jsonLog,
});
const brain = new PiBrain({
  db: { up: () => true },
  store,
  sessions,
  hands,
  setup,
  profiles: brainProfiles(
    setup,
    await loadSystemPrompts(
      {
        root: brainConfig.profileRoot ?? REPO_ROOT,
        workspace: WORKSPACE,
        checkoutRef: sandbox.checkoutRef,
        log: jsonLog,
      },
      PROFILES.values(),
    ),
    sandbox.turnTimeoutMs,
  ),
  mcp: null,
  log: jsonLog,
});

try {
  jsonLog.info('smoke starting', {
    namespace,
    image: sandbox.image,
    model: brainConfig.model,
    thinking: brainConfig.thinking,
    store: brainConfig.databaseUrl ? 'mate-db' : 'memory',
    thread: thread.id,
    mode: kill ? 'kill-mid-turn' : 'round-trip',
  });
  const row = await store.open(thread, DEFAULT_PROFILE);
  const session = await brain.open(row);
  const promptedAt = Date.now();
  const sink = new Streaming(promptedAt);
  let killed = false;
  const armed = kill
    ? setInterval(() => {
        if (killed || !readySandbox || !sink.toolEndedAt) return;
        killed = true;
        void deleteSandbox(readySandbox);
      }, 250)
    : null;
  const fallback = kill
    ? setTimeout(() => {
        if (!killed && readySandbox) {
          killed = true;
          void deleteSandbox(readySandbox);
        }
      }, KILL_FALLBACK_MS)
    : null;
  const result = await brain.prompt(session, PROMPT, sink, {
    asker: 'smoke',
    message: { channelId: thread.channelId, id: thread.id },
  });
  if (armed) clearInterval(armed);
  if (fallback) clearTimeout(fallback);
  const finalMs = Date.now() - promptedAt;
  process.stdout.write('\n');
  jsonLog.info('turn ended', {
    stopReason: result.stopReason,
    error: result.error ?? null,
    costUsd: result.costUsd ?? null,
    chars: sink.text.length,
    killedMidTurn: killed,
  });
  failed = kill
    ? result.stopReason === 'error'
    : result.stopReason !== 'end_turn';

  const pod = readySandbox && !killed ? await podOf(readySandbox) : null;
  await brain.release(thread, 'quiet');
  if (pod) await waitForPodGone(kube, namespace, pod);
  const sample = connect as HandsConnectSample | null;
  report([
    ['prompt → first token', sink.firstTextAt],
    [
      'first tool → sandbox ready',
      readyAt && sink.firstToolAt ? readyAt - sink.firstToolAt : null,
    ],
    ['hands connect', sample?.connectMs],
    ['prompt → final', finalMs],
  ]);
} catch (error) {
  failed = true;
  jsonLog.error('smoke failed', { error: plain(error) });
  await brain.release(thread, 'error');
} finally {
  // The fake thread must not rehydrate at mate's next boot.
  await brain.forget(thread);
  await store.delete(threadKey(thread)).catch((error) =>
    jsonLog.warn('the smoke thread could not be deleted', {
      error: plain(error),
    }),
  );
  await close().catch(() => {});
}

process.exitCode = failed ? 1 : 0;
