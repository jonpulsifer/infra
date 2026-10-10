import { systemClock } from './clock.ts';
import { ConfigError, readConfig, type SlackConfig } from './config.ts';
import { discordListener, discordOver } from './discord.ts';
import { createGateway } from './gateway.ts';
import { Health } from './health.ts';
import { discoverKube } from './kube.ts';
import { jsonLog as log, plain } from './log.ts';
import { Mate, type SlackSide } from './mate.ts';
import { getInstruments, lazyInstruments } from './metrics.ts';
import { PROFILES, validateProfiles } from './profiles.ts';
import { memorySessionStore, postgresSessionStore } from './session.ts';
import { openSocket, slackEvents, slackSurface, slackWeb } from './slack.ts';
import { SocketMode } from './socket.ts';
import { openDatabase, PostgresEventClaims } from './store.ts';
import type { SurfaceListener } from './surface.ts';
import {
  EXPORT_TIMEOUT_MS,
  startTelemetry,
  stopTelemetry,
} from './telemetry.ts';

const EXIT_CONFIG = 64;
// Must exceed EXPORT_TIMEOUT_MS, or a slow collector loses the last export,
// which carries the fatal-close count. The extra second covers shutdown.
const FLUSH_BUDGET_MS = EXPORT_TIMEOUT_MS + 1_000;

function exitOnConfigError(error: unknown): void {
  if (error instanceof ConfigError) {
    log.error('config error', { error: error.message });
    process.exit(EXIT_CONFIG);
  }
}

function loadConfig() {
  try {
    const config = readConfig(process.env);
    validateProfiles(PROFILES, { turnTimeoutMs: config.sandbox.turnTimeoutMs });
    return config;
  } catch (error) {
    exitOnConfigError(error);
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

if (
  process.env.MATE_KTHX_MCP_URL?.trim() &&
  !config.brain.mcpServers.some((server) => server.name === 'kthx')
) {
  log.warn('MATE_KTHX_MCP_URL is set without KTHX_AGENT_TOKEN; no kthx tools');
}

const health = new Health();
const server = Bun.serve({
  port: config.port,
  fetch: (request) => health.fetch(request),
});
const database = await openDatabase(config.brain, log, {
  metrics: lazyInstruments(),
});
const store = database.sql
  ? postgresSessionStore(database, log)
  : memorySessionStore();
const { client, manager, budget, leave } = createGateway({
  token: config.token,
  store,
  log,
  health,
  clock: systemClock,
  onLimit: (limit) => getInstruments().identifyLimit(limit),
  onClose: (code, fatal) => getInstruments().gatewayClosed(code, fatal),
  exit: exitAfterFlush,
});

async function openSlack(slack: SlackConfig): Promise<SlackSide> {
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
  const surface = slackSurface({
    api,
    me: identity.userId,
    appBotId: identity.appBotId,
    teamId: slack.teamId,
    allowedUserIds: slack.allowedUserIds,
    allowedChannelIds: slack.allowedChannelIds,
    log,
    clock: systemClock,
  });
  let socket: SocketMode | null = null;
  const listener: SurfaceListener = {
    async start(threads) {
      await threads.add(surface);
      const events = slackEvents({
        me: identity.userId,
        allowedUserIds: slack.allowedUserIds,
        threads,
        metrics: lazyInstruments(),
        log,
      });
      const claims = database.sql
        ? new PostgresEventClaims(database.sql)
        : null;
      socket = new SocketMode({
        open: () => openSocket(slack.appToken),
        connect: (url) => new WebSocket(url),
        clock: systemClock,
        log,
        since: Date.now(),
        claim: claims
          ? async (id, at) => {
              if (!database.up()) throw new Error('the store is not up');
              return claims.claim(id, at);
            }
          : undefined,
        answers: events.answers,
        onEvent: events.onEvent,
        onStale: events.onStale,
      });
      void socket.run();
    },
    stop() {
      socket?.stop();
    },
    async close() {},
  };
  return { api, listener };
}

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { signal });
  await mate.stop();
  await stopTelemetry().catch((error) =>
    log.warn('metrics shutdown failed', { error: plain(error) }),
  );
  server.stop(true);
  process.exit(0);
}

const kube = await discoverKube();
const { slack } = config;
const discord = discordListener({
  gateway: { client, manager, budget, leave },
  api: discordOver(client.api),
  commands: client.api.applicationCommands,
  guildId: config.guildId,
  allowedUserIds: config.allowedUserIds,
  allowedChannelIds: config.allowedChannelIds,
  clock: systemClock,
  log,
});
const mate = new Mate({
  config,
  clock: systemClock,
  log,
  metrics: lazyInstruments(),
  kube,
  database,
  surfaces: {
    discord: {
      ...discord,
      // Mate starts Discord once its core is built. A signal before then
      // ends the process at once, as no turn has run yet to drain.
      start: (threads) => {
        process.on('SIGINT', () => void shutdown('SIGINT'));
        process.on('SIGTERM', () => void shutdown('SIGTERM'));
        return discord.start(threads);
      },
    },
    slack: slack ? () => openSlack(slack) : null,
  },
});

try {
  await mate.start();
} catch (error) {
  exitOnConfigError(error);
  throw error;
}
