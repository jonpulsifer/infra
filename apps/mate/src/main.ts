import {
  ComponentType,
  GatewayDispatchEvents,
  InteractionType,
} from 'discord-api-types/v10';
import { systemClock } from './clock.ts';
import { clearGlobalCommands } from './commands.ts';
import type { GithubAppConfig } from './config.ts';
import { ConfigError, readConfig, type SlackConfig } from './config.ts';
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
import { discoverKube, Kube } from './kube.ts';
import { jsonLog as log, plain } from './log.ts';
import { getInstruments, lazyInstruments } from './metrics.ts';
import { type Sandboxes, StubSandboxes } from './sandbox.ts';
import { KubeSandboxes, SPARE_SWEEP_MS } from './sandboxes.ts';
import { fileSessionStore, memorySessionStore } from './session.ts';
import { openSocket, slackEvent, slackSurface, slackWeb } from './slack.ts';
import { SocketMode } from './socket.ts';
import {
  EXPORT_TIMEOUT_MS,
  startTelemetry,
  stopTelemetry,
} from './telemetry.ts';
import { Threads } from './threads.ts';

const EXIT_CONFIG = 64;
// Must exceed EXPORT_TIMEOUT_MS, or a slow collector loses the last export,
// which carries the fatal-close count. The extra second covers shutdown.
const FLUSH_BUDGET_MS = EXPORT_TIMEOUT_MS + 1_000;

function loadConfig() {
  try {
    return readConfig(process.env);
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
    return await Bun.file(path).text();
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

const sandboxes: Sandboxes =
  config.sandboxes.mode === 'kube' && kubeConfig
    ? new KubeSandboxes({
        kube: new Kube(kubeConfig),
        config: config.sandboxes.sandbox,
        guildId: config.guildId,
        log,
        metrics: lazyInstruments(),
        githubApp,
        clusterCa: kubeConfig.ca ?? null,
        sshKey: await readSshKey(config.sandboxes.sshKeyFile),
      })
    : new StubSandboxes();
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
  sandboxes,
  clock: systemClock,
  log,
  config,
  metrics: lazyInstruments(),
});
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
  // While both surfaces can still post, so a thread still waiting to start is
  // told it never will.
  await threads
    .quiesce()
    .catch((error) => log.warn('quiesce failed', { error: plain(error) }));
  try {
    await manager.destroy();
  } catch (error) {
    log.warn('gateway destroy failed', { error: plain(error) });
  }
  await stopTelemetry().catch((error) =>
    log.warn('metrics shutdown failed', { error: plain(error) }),
  );
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

const sweep = () =>
  void sandboxes
    .ensureSpares()
    .catch((error) => log.warn('spare sweep failed', { error: plain(error) }));
setInterval(sweep, SPARE_SWEEP_MS);
sweep();

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
  maxConcurrent: config.maxConcurrent,
  quietMinutes: config.quietMs / 60_000,
  turnMinutes:
    config.sandboxes.mode === 'kube'
      ? config.sandboxes.sandbox.turnTimeoutMs / 60_000
      : null,
  port: config.port,
});
await budget.waitForBudget(new AbortController().signal);
await manager.connect();
