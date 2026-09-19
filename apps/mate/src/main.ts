import {
  ComponentType,
  GatewayDispatchEvents,
  InteractionType,
} from 'discord-api-types/v10';
import { systemClock } from './clock.ts';
import { clearGlobalCommands } from './commands.ts';
import { ConfigError, readConfig } from './config.ts';
import { discordOver, STOP_PREFIX } from './discord.ts';
import { createGateway } from './gateway.ts';
import { Health } from './health.ts';
import { discoverKube, Kube } from './kube.ts';
import { jsonLog as log, plain } from './log.ts';
import { getInstruments } from './metrics.ts';
import { type Sandboxes, StubSandboxes } from './sandbox.ts';
import { KubeSandboxes } from './sandboxes.ts';
import { fileSessionStore, memorySessionStore } from './session.ts';
import { Threads } from './threads.ts';

const EXIT_CONFIG = 64;

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
  exit: (code) => process.exit(code),
});
const sandboxes: Sandboxes =
  config.sandboxes.mode === 'kube'
    ? new KubeSandboxes({
        kube: new Kube(await discoverKube()),
        config: config.sandboxes.sandbox,
        guildId: config.guildId,
        log,
      })
    : new StubSandboxes();
const discord = discordOver(client.api);
let threads: Threads | null = null;
let me = '';

client.once(GatewayDispatchEvents.Ready, async ({ data }) => {
  me = data.user.id;
  threads = new Threads({
    discord,
    sandboxes,
    clock: systemClock,
    log,
    config,
    me,
    onTurn: () => getInstruments().turnStarted(),
  });
  log.info('ready', {
    user: data.user.username,
    userId: me,
    applicationId: data.application.id,
    guilds: data.guilds.length,
  });
  await threads.rehydrate();
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
      threads?.adopt(thread.id, thread.parent_id);
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
  threads?.adopt(data.id, data.parent_id);
  await discord.joinThread(data.id).catch((error) =>
    log.warn('thread join failed', {
      threadId: data.id,
      error: plain(error),
    }),
  );
});

client.on(GatewayDispatchEvents.ThreadUpdate, ({ data }) => {
  if (data.thread_metadata?.archived) void threads?.onThreadArchived(data.id);
});

client.on(GatewayDispatchEvents.ThreadDelete, ({ data }) => {
  void threads?.onThreadDeleted(data.id);
});

client.on(GatewayDispatchEvents.MessageCreate, ({ data }) => {
  void threads?.onMessage({
    id: data.id,
    guildId: data.guild_id ?? null,
    channelId: data.channel_id,
    authorId: data.author.id,
    authorIsBot: data.author.bot ?? false,
    content: data.content,
    mentionsMe: data.mentions.some((user) => user.id === me),
  });
});

client.on(GatewayDispatchEvents.InteractionCreate, ({ data }) => {
  if (data.type !== InteractionType.MessageComponent) return;
  if (data.data.component_type !== ComponentType.Button) return;
  const customId = data.data.custom_id;
  if (!customId.startsWith(STOP_PREFIX)) return;
  const userId = data.member?.user.id ?? data.user?.id ?? '';
  void threads?.onStop(customId.slice(STOP_PREFIX.length), userId, () =>
    discord.ackUpdate(data.id, data.token),
  );
});

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { signal });
  try {
    await manager.destroy();
  } catch (error) {
    log.warn('gateway destroy failed', { error: plain(error) });
  }
  server.stop(true);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log.info('mate starting', {
  sandboxes: config.sandboxes.mode,
  guildId: config.guildId,
  allowedUsers: config.allowedUserIds.size,
  allowedChannels: [...config.allowedChannelIds],
  maxConcurrent: config.maxConcurrent,
  quietMinutes: config.quietMs / 60_000,
  port: config.port,
});
await budget.waitForBudget(new AbortController().signal);
await manager.connect();
