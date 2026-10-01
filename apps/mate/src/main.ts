import { fileURLToPath } from 'node:url';
import {
  ComponentType,
  GatewayDispatchEvents,
  InteractionType,
} from 'discord-api-types/v10';
import { PiBrain, postgresSessions, type SessionSource } from './brain.ts';
import type {
  BrainProfile,
  McpBridge,
  ModelSetup,
  ProfilePrompts,
} from './brain-inputs.ts';
import type { Brain } from './brain-port.ts';
import { ChatgptAccount, ChatgptKeeper } from './chatgpt.ts';
import { systemClock } from './clock.ts';
import { clearGlobalCommands } from './commands.ts';
import {
  type BrainConfig,
  ConfigError,
  type GithubAppConfig,
  readConfig,
  type SlackConfig,
} from './config.ts';
import { PostgresCredentialStore } from './credential-store.ts';
import { Custodian, PostgresCustodianLedger } from './custodian.ts';
import {
  discordInbound,
  discordOver,
  discordSurface,
  discordThread,
  STOP_PREFIX,
} from './discord.ts';
import { createGateway } from './gateway.ts';
import { GithubApp } from './github-app.ts';
import { Health } from './health.ts';
import { KthxSites } from './kthx-sites.ts';
import { discoverKube, Kube, type KubeConfig } from './kube.ts';
import { type Hands, WORKSPACE } from './lease.ts';
import { jsonLog as log, plain } from './log.ts';
import { combineMcp, createMcpBridge } from './mcp.ts';
import { getInstruments, lazyInstruments } from './metrics.ts';
import { chatgptModel, createModelSetup } from './model.ts';
import { brainProfiles, loadSystemPrompts } from './profile.ts';
import { PROFILES, validateProfiles } from './profiles.ts';
import { StubBrain } from './sandbox.ts';
import { createKubeHands, SPARE_SWEEP_MS } from './sandboxes.ts';
import { fileSessionStore, memorySessionStore } from './session.ts';
import { openSocket, slackEvent, slackSurface, slackWeb } from './slack.ts';
import { SocketMode } from './socket.ts';
import { opensshKey } from './ssh-key.ts';
import {
  type Database,
  MemoryThreadStore,
  openDatabase,
  PostgresThreadStore,
} from './store.ts';
import type { ThreadRef } from './surface.ts';
import {
  EXPORT_TIMEOUT_MS,
  startTelemetry,
  stopTelemetry,
} from './telemetry.ts';
import type { ThreadStore } from './thread-store.ts';
import { DRAIN_MS, Threads } from './threads.ts';

const EXIT_CONFIG = 64;
const DAY_MS = 86_400_000;
const RETENTION_SWEEP_MS = 3_600_000;
// The profile beside the source: the repo root, or /app in the image.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Must exceed EXPORT_TIMEOUT_MS, or a slow collector loses the last export,
// which carries the fatal-close count. The extra second covers shutdown.
const FLUSH_BUDGET_MS = EXPORT_TIMEOUT_MS + 1_000;

function loadConfig() {
  try {
    const config = readConfig(process.env);
    if (config.sandboxes.mode === 'kube') {
      validateProfiles(PROFILES, {
        turnTimeoutMs: config.sandboxes.sandbox.turnTimeoutMs,
      });
    }
    return config;
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('config error', { error: error.message });
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
}

const config = loadConfig();
// Before any meter is used: an instrument created ahead of the SDK stays a
// no-op for the life of the process.
startTelemetry(process.env, log);

function exitAfterFlush(code: number): void {
  const done = () => process.exit(code);
  const timer = setTimeout(done, FLUSH_BUDGET_MS);
  void stopTelemetry().then(
    () => {
      clearTimeout(timer);
      done();
    },
    () => {
      clearTimeout(timer);
      done();
    },
  );
}

const health = new Health();
const server = Bun.serve({
  port: config.port,
  fetch: (request) => health.fetch(request),
});
const store = config.sessionFile
  ? fileSessionStore(config.sessionFile, log)
  : memorySessionStore();
const { client, manager, budget } = createGateway({
  token: config.token,
  store,
  log,
  health,
  clock: systemClock,
  onLimit: (limit) => getInstruments().identifyLimit(limit),
  onClose: (code, fatal) => getInstruments().gatewayClosed(code, fatal),
  exit: exitAfterFlush,
});
// An unreadable key is not fatal: with one replica, refusing to boot would
// take both chat surfaces down over the credential for pushing.
const githubApp =
  config.sandboxes.mode === 'kube' && config.sandboxes.githubApp
    ? await openGithubApp(
        config.sandboxes.githubApp,
        config.sandboxes.sandbox.turnTimeoutMs,
      )
    : null;

async function openGithubApp(
  app: GithubAppConfig,
  turnTimeoutMs: number,
): Promise<GithubApp | null> {
  try {
    if (!/^\d+$/.test(app.appId)) {
      throw new Error('MATE_GITHUB_APP_ID is not a numeric App id');
    }
    const privateKey = await Bun.file(app.keyFile).text();
    return new GithubApp({
      appId: app.appId,
      privateKey,
      owner: app.owner,
      repo: app.repo,
      turnTimeoutMs,
      clock: systemClock,
      log,
    });
  } catch (error) {
    // An App id is set, so a key that fails to open reports not ready.
    getInstruments().githubAppReady(false);
    log.error('the GitHub App could not be opened', {
      keyFile: app.keyFile,
      error: plain(error),
    });
    return null;
  }
}

// Read once at boot, so a failure is one log line. Unreadable is not fatal,
// for the same reason as the App key.
async function readSshKey(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    return opensshKey(await Bun.file(path).text());
  } catch (error) {
    log.error('the sandbox SSH key could not be read', {
      keyFile: path,
      error: plain(error),
    });
    return null;
  }
}

const kubeConfig =
  config.sandboxes.mode === 'kube' ? await discoverKube() : null;
const kube = kubeConfig ? new Kube(kubeConfig) : null;

// The ledger lives in mate's own namespace, whichever one holds the sandboxes.
function openKthxSites(kube: Kube): KthxSites | null {
  if (config.sandboxes.mode !== 'kube') return null;
  const { kthx } = config.sandboxes.sandbox;
  if (!kthx.origin) return null;
  log.info('kthx sites ledger on', {
    origin: kthx.origin,
    secret: kthx.sitesSecret,
  });
  return new KthxSites({
    kube,
    namespace: kube.namespace,
    secret: kthx.sitesSecret,
    log,
  });
}

// A model the catalog lacks is a ConfigError: every turn would fail.
function openModel(
  brain: BrainConfig,
  credentials: PostgresCredentialStore | null,
): ModelSetup {
  try {
    return createModelSetup({
      spec: brain.model,
      thinking: brain.thinking,
      fallbackSpec: brain.fallbackModel,
      fallbackThinking: brain.fallbackThinking,
      keyFile: brain.modelKeyFile,
      credentials: credentials ?? undefined,
      log,
      clock: systemClock,
      metrics: lazyInstruments(),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('config error', { error: error.message });
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
}

// A profile model the catalog lacks is a ConfigError, as for MATE_MODEL.
function openProfiles(
  setup: ModelSetup,
  prompts: ProfilePrompts,
  turnTimeoutMs: number,
): ReadonlyMap<string, BrainProfile> {
  try {
    return brainProfiles(setup, prompts, turnTimeoutMs);
  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('config error', { error: error.message });
      process.exit(EXIT_CONFIG);
    }
    throw error;
  }
}

function openMcp(brain: BrainConfig): McpBridge | null {
  if (
    process.env.MATE_KTHX_MCP_URL?.trim() &&
    !brain.mcpServers.some((server) => server.name === 'kthx')
  ) {
    log.warn(
      'MATE_KTHX_MCP_URL is set without KTHX_AGENT_TOKEN; no kthx tools',
    );
  }
  if (brain.mcpServers.length === 0) return null;
  const bridge = combineMcp(
    brain.mcpServers.map((server) => {
      log.info(`${server.name} mcp on`, { url: server.url });
      return createMcpBridge({
        name: server.name,
        prefix: `${server.name}_`,
        url: server.url,
        ...(server.token ? { token: server.token } : {}),
        log,
        metrics: lazyInstruments(),
      });
    }),
  );
  bridge.start();
  return bridge;
}

interface Chatgpt {
  account: ChatgptAccount;
  keeper: ChatgptKeeper;
  credentials: PostgresCredentialStore;
}

interface Wiring {
  brain: Brain;
  threadStore: ThreadStore;
  storeReady: Promise<void>;
  inherited: readonly ThreadRef[];
  hands: Hands | null;
  db: Database | null;
  mcp: McpBridge | null;
  sweep: ((before: number) => Promise<void>) | null;
  chatgpt: Chatgpt | null;
}

// Signed in from chat and kept fresh by the keeper, which tells the router of
// each sign-in and refusal.
function openChatgpt(
  setup: ModelSetup,
  credentials: PostgresCredentialStore,
): Chatgpt {
  const keeper = new ChatgptKeeper({
    models: setup.direct,
    credentials,
    clock: systemClock,
    log,
    metrics: lazyInstruments(),
    router: setup.router,
  });
  const account = new ChatgptAccount({
    models: setup.direct,
    keeper,
    credentials,
    model: chatgptModel(setup),
    lane: { model: setup.model, thinking: setup.thinking },
    router: setup.router,
    clock: systemClock,
    log,
  });
  return { account, keeper, credentials };
}

async function kubeWiring(kube: Kube, kubeConfig: KubeConfig): Promise<Wiring> {
  if (config.sandboxes.mode !== 'kube') throw new Error('not in kube mode');
  const { brain: brainConfig, sandbox, sshKeyFile } = config.sandboxes;
  const db = await openDatabase(brainConfig, log, {
    metrics: lazyInstruments(),
  });
  const credentials = db.sql
    ? new PostgresCredentialStore({ db, log, metrics: lazyInstruments() })
    : null;
  const setup = openModel(brainConfig, credentials);
  const prompts = await loadSystemPrompts(
    {
      root: brainConfig.profileRoot ?? REPO_ROOT,
      workspace: WORKSPACE,
      checkoutRef: sandbox.checkoutRef,
      log,
    },
    PROFILES.values(),
  );
  const profiles = openProfiles(setup, prompts, sandbox.turnTimeoutMs);
  const mcp = openMcp(brainConfig);
  const hands = createKubeHands({
    kube,
    config: sandbox,
    guildId: config.guildId,
    maxSandboxes: config.maxSandboxes,
    log,
    metrics: lazyInstruments(),
    githubApp,
    kthxSites: openKthxSites(kube),
    clusterCa: kubeConfig.ca ?? null,
    sshKey: await readSshKey(sshKeyFile),
  });
  const inherited = await hands.start().catch((error) => {
    log.error('the hands could not start', { error: plain(error) });
    return [];
  });
  // With no database the rows live in memory, and every open is refused.
  const threadStore = db.sql
    ? new PostgresThreadStore(db.sql)
    : new MemoryThreadStore();
  const sessions: SessionSource = db.sql
    ? postgresSessions(db.sql)
    : {
        open: () => Promise.reject(new Error('mate has no database')),
        delete: async () => {},
      };
  const brain = new PiBrain({
    db,
    store: threadStore,
    sessions,
    hands,
    setup,
    profiles,
    mcp,
    log,
    metrics: lazyInstruments(),
  });
  return {
    brain,
    threadStore,
    storeReady: db.ready,
    inherited,
    hands,
    db,
    mcp,
    sweep: (before) => brain.sweep(before),
    chatgpt: credentials ? openChatgpt(setup, credentials) : null,
  };
}

/** A store with no pool never comes up: its URL or CA is missing. */
function storeState(db: Database | null): string {
  if (!db) return 'memory';
  if (db.sql === null) return 'down';
  return db.up() ? 'up' : 'migrating';
}

function stubWiring(): Wiring {
  // MateNotReporting fires on an absent gauge, and no hands report it here.
  getInstruments().sandboxesLive(0);
  return {
    brain: new StubBrain(),
    threadStore: new MemoryThreadStore(),
    storeReady: Promise.resolve(),
    inherited: [],
    hands: null,
    db: null,
    mcp: null,
    sweep: null,
    chatgpt: null,
  };
}

const wiring =
  kube && kubeConfig ? await kubeWiring(kube, kubeConfig) : stubWiring();

const discord = discordOver(client.api);

async function openSlack(slack: SlackConfig) {
  const api = slackWeb(slack.botToken, { clock: systemClock, log });
  const identity = await api.identity();
  if (identity.teamId !== slack.teamId) {
    throw new Error(
      `MATE_SLACK_TEAM_ID is ${slack.teamId} but the token belongs to ${identity.teamId}`,
    );
  }
  log.info('slack ready', {
    teamId: identity.teamId,
    userId: identity.userId,
    allowedUsers: slack.allowedUserIds.size,
    allowedChannels: [...slack.allowedChannelIds],
  });
  return {
    api,
    surface: slackSurface({
      api,
      me: identity.userId,
      appBotId: identity.appBotId,
      teamId: slack.teamId,
      allowedUserIds: slack.allowedUserIds,
      allowedChannelIds: slack.allowedChannelIds,
      log,
      clock: systemClock,
    }),
    listen(threads: Threads): SocketMode {
      const socket = new SocketMode({
        open: () => openSocket(slack.appToken),
        connect: (url) => new WebSocket(url),
        clock: systemClock,
        log,
        since: Date.now(),
        onEvent: (payload) =>
          slackEvent(payload.event ?? {}, identity.userId, {
            // The socket already acked the envelope, the only ack Slack
            // waits for.
            stopped: (stop) =>
              void threads.onStop(stop.key, stop.userId, async () => {}),
            message: (inbound) => void threads.onMessage(inbound),
          }),
      });
      void socket.run();
      return socket;
    },
  };
}

// A Slack failure is not fatal: a crash loop would take Discord down with it.
const slack = config.slack
  ? await openSlack(config.slack).catch((error) => {
      log.error('slack could not be opened; answering on Discord alone', {
        error: plain(error),
      });
      return null;
    })
  : null;

const threads = new Threads({
  surfaces: [],
  brain: wiring.brain,
  store: wiring.threadStore,
  storeReady: wiring.storeReady,
  inherited: wiring.inherited,
  clock: systemClock,
  log,
  config,
  metrics: lazyInstruments(),
  commands: wiring.chatgpt?.account,
});
wiring.chatgpt?.keeper.start(wiring.storeReady);
const custodian =
  config.custodianChannel && slack && wiring.db?.sql
    ? new Custodian({
        ledger: new PostgresCustodianLedger(wiring.db.sql),
        slack: slack.api,
        threads,
        channel: config.custodianChannel,
        owner: [...(config.slack?.allowedUserIds ?? [])][0] ?? '',
        log,
      })
    : null;
if (custodian) void wiring.storeReady.then(() => custodian.start());
else if (config.custodianChannel)
  log.warn('custodian disabled: Slack or database unavailable');
let me = '';

// Before the gateway: a revoked or rate-limited Discord token, or a wait on
// the identify budget, must not hold Slack back.
let socket: SocketMode | null = null;
if (slack) {
  await threads.add(slack.surface);
  socket = slack.listen(threads);
}

client.once(GatewayDispatchEvents.Ready, async ({ data }) => {
  me = data.user.id;
  await threads.add(
    discordSurface(discord, {
      me,
      allowedUserIds: config.allowedUserIds,
      allowedChannelIds: config.allowedChannelIds,
      clock: systemClock,
    }),
  );
  log.info('ready', {
    user: data.user.username,
    userId: me,
    applicationId: data.application.id,
    guilds: data.guilds.length,
    surfaces: threads.surfaceNames,
  });
  try {
    await clearGlobalCommands(
      client.api.applicationCommands,
      data.application.id,
      log,
    );
  } catch (error) {
    log.warn('global command cleanup failed', { error: plain(error) });
  }
});

client.on(GatewayDispatchEvents.GuildCreate, ({ data }) => {
  if (data.id !== config.guildId) {
    log.warn("ignoring a guild that is not mate's", { guildId: data.id });
    return;
  }
  for (const channel of data.channels) {
    if (config.allowedChannelIds.has(channel.id)) {
      log.info('allowed channel', {
        channelId: channel.id,
        name: channel.name,
      });
    }
  }
  for (const thread of data.threads) {
    if (thread.owner_id === me && thread.parent_id) {
      threads.adopt(discordThread(thread.id, thread.parent_id));
    }
  }
  log.info('guild ready', {
    guildId: data.id,
    activeThreads: data.threads.length,
  });
});

client.on(GatewayDispatchEvents.ThreadCreate, async ({ data }) => {
  if (
    data.guild_id !== config.guildId ||
    data.owner_id !== me ||
    !data.parent_id
  )
    return;
  threads.adopt(discordThread(data.id, data.parent_id));
  await discord.joinThread(data.id).catch((error) =>
    log.warn('thread join failed', {
      threadId: data.id,
      error: plain(error),
    }),
  );
});

client.on(GatewayDispatchEvents.ThreadUpdate, ({ data }) => {
  if (data.thread_metadata?.archived) {
    void threads.onThreadArchived(discordThread(data.id, data.parent_id ?? ''));
  }
});

client.on(GatewayDispatchEvents.ThreadDelete, ({ data }) => {
  void threads.onThreadDeleted(discordThread(data.id, data.parent_id ?? ''));
});

client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
  const inbound = discordInbound(
    {
      id: data.id,
      guildId: data.guild_id ?? null,
      channelId: data.channel_id,
      authorId: data.author.id,
      authorIsBot: data.author.bot ?? false,
      content: data.content,
      mentionsMe: data.mentions.some((user) => user.id === me),
    },
    config.guildId,
  );
  if (inbound) void threads.onMessage(inbound);
});

client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => {
  if (data.type !== InteractionType.MessageComponent) return;
  if (data.data.component_type !== ComponentType.Button) return;
  const customId = data.data.custom_id;
  if (!customId.startsWith(STOP_PREFIX)) return;
  const userId = data.member?.user.id ?? data.user?.id ?? '';
  void threads.onStop(customId.slice(STOP_PREFIX.length), userId, () =>
    discord.ackUpdate(data.id, data.token),
  );
});

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { signal });
  // First: envelopes are acked on receipt, so one taken during the drain is
  // lost for good.
  socket?.stop();
  custodian?.stop();
  // While both surfaces can still post: running turns finish or stay open for
  // the next process to resume, and queued prompts are told they never started.
  await threads
    .drain(DRAIN_MS)
    .catch((error) => log.warn('drain failed', { error: plain(error) }));
  await wiring.hands?.shutdown();
  wiring.chatgpt?.keeper.stop();
  // While the surfaces can still post: a sign-in waiting for its code tells
  // its thread that the code no longer works.
  await wiring.chatgpt?.account.stop();
  try {
    await manager.destroy();
  } catch (error) {
    log.warn('gateway destroy failed', { error: plain(error) });
  }
  await wiring.mcp?.close().catch(() => {});
  // Before the pool closes: a refresh still running saves its rotated token,
  // and one that did not save gets a last try.
  await wiring.chatgpt?.credentials.close().catch(() => {});
  await wiring.db
    ?.close()
    .catch((error) =>
      log.warn('database close failed', { error: plain(error) }),
    );
  await stopTelemetry().catch((error) =>
    log.warn('metrics shutdown failed', { error: plain(error) }),
  );
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const spares = () =>
  void wiring.hands
    ?.ensureSpares()
    .catch((error) => log.warn('spare sweep failed', { error: plain(error) }));
if (wiring.hands) {
  setInterval(spares, SPARE_SWEEP_MS);
  spares();
}

const retentionDays =
  config.sandboxes.mode === 'kube'
    ? config.sandboxes.brain.sessionRetentionDays
    : 0;
const retain = () =>
  void wiring
    .sweep?.(Date.now() - retentionDays * DAY_MS)
    .catch((error) =>
      log.warn('the retention sweep failed', { error: plain(error) }),
    );
if (wiring.sweep && retentionDays > 0) setInterval(retain, RETENTION_SWEEP_MS);

// A real mint at boot and on a timer keeps `mate_github_app_ready` current
// even when no turn has pushed.
const PREFLIGHT_MS = 15 * 60_000;
const preflight = () => {
  if (!githubApp) return;
  void githubApp
    .preflight()
    .then((status) => {
      getInstruments().githubAppReady(true);
      log.info('github app ready', {
        installationId: status.installationId,
        login: status.login,
        expiresAt: new Date(status.expiresAt).toISOString(),
      });
    })
    .catch((error) => {
      getInstruments().githubAppReady(false);
      log.error('github app NOT ready', { error: plain(error) });
    });
};
if (githubApp) {
  setInterval(preflight, PREFLIGHT_MS);
  preflight();
}

log.info('mate starting', {
  sandboxes: config.sandboxes.mode,
  guildId: config.guildId,
  allowedUsers: config.allowedUserIds.size,
  allowedChannels: [...config.allowedChannelIds],
  slack: Boolean(config.slack),
  model: config.sandboxes.mode === 'kube' ? config.sandboxes.brain.model : null,
  thinking:
    config.sandboxes.mode === 'kube' ? config.sandboxes.brain.thinking : null,
  fallback:
    config.sandboxes.mode === 'kube'
      ? config.sandboxes.brain.fallbackModel
      : null,
  maxConcurrent: config.maxConcurrent,
  maxSandboxes: config.maxSandboxes,
  store: storeState(wiring.db),
  chatgpt: Boolean(wiring.chatgpt),
  quietMinutes: config.quietMs / 60_000,
  turnMinutes:
    config.sandboxes.mode === 'kube'
      ? config.sandboxes.sandbox.turnTimeoutMs / 60_000
      : null,
  port: config.port,
});
await budget.waitForBudget(new AbortController().signal);
await manager.connect();
