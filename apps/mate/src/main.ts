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
/**
 * How long an exiting process waits for the last metrics export. The order
 * between these two numbers is load-bearing and that is why it is written as
 * arithmetic rather than a literal: the flush is one export, which the
 * exporter itself allows `EXPORT_TIMEOUT_MS` to finish, so a budget shorter
 * than that would call `process.exit` on a collector that is merely slow and
 * throw the export away. That export is the only reason
 * MateGatewayFatalClose can fire at all, since the process dies immediately
 * after counting the close. The spare second covers the shutdown around it,
 * and the whole budget sits well inside the pod's 30s termination grace.
 */
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
// Before anything can reach a meter: an instrument minted ahead of the SDK is
// a no-op for the life of the process.
startTelemetry(process.env, log);

/**
 * Exit once the last export is away, or once the budget runs out. The two
 * exits below both mean a configuration error that will not fix itself, and
 * the counter that says which one is only useful if it leaves the process.
 */
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
/**
 * The App a sandbox's GitHub token is minted from, or `null` where none is
 * configured. A key that cannot be read is deliberately not fatal: mate runs
 * one replica under `strategy: Recreate`, so refusing to boot over the
 * credential for pushing would take both chat surfaces down to protect a
 * feature neither of them needs. It is one error line and a gauge instead.
 */
const githubApp =
  config.sandboxes.mode === 'kube' && config.sandboxes.githubApp
    ? await openGithubApp(
        config.sandboxes.githubApp,
        config.sandboxes.sandbox.turnTimeoutMs,
      )
    : null;

/**
 * Reads the mounted PEM and builds the App. A missing or malformed key is one
 * error line and `null` — the caller treats that as "no App configured", and
 * `mate_github_app_ready` reports the same 0 it would for a key GitHub has
 * stopped accepting, because to a thread that cannot push they are one thing.
 */
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
    // Reported as a broken credential rather than as a missing one: somebody
    // asked for an App by setting its id, so silence here would be the same
    // shape of failure this whole path exists to stop being silent.
    getInstruments().githubAppReady(false);
    log.error('the GitHub App could not be opened', {
      keyFile: app.keyFile,
      error: plain(error),
    });
    return null;
  }
}

/**
 * The SSH key a turn is stamped with, or `null`. Read once, here, rather than
 * per turn: it is a file on mate's own pod, it does not change under a running
 * process, and a read that happens at boot is a read whose failure is one log
 * line at a known moment instead of a surprise in somebody's thread.
 *
 * Unreadable is never fatal, for the reason the App key is not: one replica
 * under `strategy: Recreate` means refusing to boot over a credential for a
 * side feature takes both chat surfaces down with it.
 */
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

/**
 * The Slack half, opened before the gateway: its own socket, its own
 * identity, and no dependence on Discord being up. A Slack-side failure is
 * one loud line and a mate that answers on Discord alone, because the
 * alternative is a crash loop that takes the surface that was working down
 * with the one that was not.
 */
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
            // Slack's own stop control: the same cancel the Discord button
            // asks for, on the same thread key, and already acknowledged on
            // the socket — which is the only ack Slack is waiting for.
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

// Slack comes up on its own, before the gateway is dialled: the surfaces are
// independent everywhere else, and a Discord token that is revoked, rate
// limited or merely waiting out the identify budget must not leave the other
// one silent with nothing in the log naming the reason.
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
  // First: an envelope is acknowledged on receipt, so one that arrived during
  // the drain is one Slack will not send again, and closing the socket is
  // what stops another from being taken and dropped.
  socket?.stop();
  // Before the gateway goes, while both surfaces can still be written to: a
  // thread watching a line about a sandbox being started is owed the news
  // that it never will be.
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

/**
 * The warm pool's cadence, which is also the renewal `SPARE_TTL_MS` is sized
 * against. With `MATE_SPARES` unset the pass returns without asking the
 * apiserver anything, so this timer costs a bot with no pool nothing.
 */
const sweep = () =>
  void sandboxes
    .ensureSpares()
    .catch((error) => log.warn('spare sweep failed', { error: plain(error) }));
setInterval(sweep, SPARE_SWEEP_MS);
sweep();

/**
 * Proves the GitHub credential rather than assuming it, on a cadence, and
 * publishes the answer as `mate_github_app_ready`.
 *
 * This exists because of how the credential it replaces failed: nothing ever
 * exercised it, so a broken one was discovered by a human asking for a pull
 * request and being told the wrong reason. A mint at boot and every quarter
 * hour costs one API call and makes the gauge a current fact rather than an
 * inference from whenever a turn last ran.
 */
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
