/**
 * Test support for driving a whole `Mate`: a config, a database over the
 * test's own pool, pi's faux model, and Discord's real listener over a fake
 * gateway whose events the test dispatches.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from '@earendil-works/pi-ai';
import {
  type FauxResponseStep,
  fauxProvider,
} from '@earendil-works/pi-ai/providers/faux';
import type { SQL } from 'bun';
import {
  ComponentType,
  GatewayDispatchEvents,
  InteractionType,
} from 'discord-api-types/v10';
import { type Clock, type Handle, systemClock } from '../src/clock.ts';
import type { BrainConfig, Config, SandboxConfig } from '../src/config.ts';
import { discordListener, STOP_PREFIX } from '../src/discord.ts';
import type { Log } from '../src/log.ts';
import type { Database } from '../src/store.ts';
import type { SurfaceListener } from '../src/surface.ts';
import { GUILD, SANDBOX_CONFIG, tempDir } from './hands-support.ts';
import { type FakeDiscord, FakeGateway, settle } from './support.ts';

export const ME = '900000000000000001';
export const OWNER = '308072071949320204';
export const CHANNEL = '1509024937422356532';
export const APP = '900000000000000002';

/** Real time, with every timer it armed cancelled at the end of a test. */
export class RealClock implements Clock {
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

/** A profile root holding only a short AGENTS.md. */
export function profileRoot(): string {
  const root = tempDir('profile');
  writeFileSync(join(root, 'AGENTS.md'), 'You help.\n');
  return root;
}

export interface ConfigOverrides
  extends Partial<Omit<Config, 'sandbox' | 'brain'>> {
  readonly sandbox?: Partial<SandboxConfig>;
  readonly brain?: Partial<BrainConfig>;
}

/** mate on pi's faux model, Discord alone, and every credential off. */
export function mateConfig(overrides: ConfigOverrides = {}): Config {
  const { sandbox, brain, ...rest } = overrides;
  return {
    token: 'discord-token',
    guildId: GUILD,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
    quietMs: 3_600_000,
    maxTurnsPerThread: 30,
    maxTurnsPerDay: 120,
    maxConcurrent: 3,
    maxSandboxes: 4,
    port: 0,
    sessionFile: null,
    sandbox: { ...SANDBOX_CONFIG, turnTimeoutMs: 60_000, ...sandbox },
    brain: {
      model: 'faux/faux',
      thinking: 'off',
      fallbackModel: null,
      fallbackThinking: null,
      modelKeyFile: '/nonexistent/opencode-key',
      databaseUrl: null,
      databaseCaFile: '/nonexistent/ca.crt',
      mcpServers: [],
      profileRoot: profileRoot(),
      sessionRetentionDays: 0,
      ...brain,
    },
    githubApp: null,
    sshKeyFile: null,
    slack: null,
    custodianChannel: null,
    ...rest,
  };
}

export interface TestDatabase extends Database {
  /** Called as mate closes it; the pool itself stays open for the next test. */
  onClose: () => void | Promise<void>;
}

/** The test's pool as mate's database, already migrated. */
export function testDatabase(sql: SQL | null): TestDatabase {
  const db: TestDatabase = {
    sql,
    up: () => sql !== null,
    ready: sql ? Promise.resolve() : new Promise(() => {}),
    onClose: () => {},
    close: async () => {
      await db.onClose();
    },
  };
  return db;
}

/** pi's faux provider, as `faux/faux`. */
export function fauxModel(): {
  provider: Provider;
  respond(...steps: FauxResponseStep[]): void;
} {
  const faux = fauxProvider({
    api: 'faux',
    provider: 'faux',
    tokenSize: { min: 3, max: 3 },
    models: [{ id: 'faux', reasoning: true }],
  });
  return {
    provider: faux.provider,
    respond: (...steps) => faux.setResponses(steps),
  };
}

let serial = 0;

/** Discord's real listener over a gateway the test dispatches on. */
export class DiscordDriver {
  readonly gateway = new FakeGateway();
  readonly listener: SurfaceListener;

  constructor(
    readonly api: FakeDiscord,
    clock: Clock,
    log: Log,
  ) {
    this.listener = discordListener({
      gateway: this.gateway,
      api,
      commands: {
        getGlobalCommands: async () => [] as never,
        bulkOverwriteGlobalCommands: async () => [] as never,
      },
      guildId: GUILD,
      allowedUserIds: new Set([OWNER]),
      allowedChannelIds: new Set([CHANNEL]),
      clock,
      log,
    });
  }

  async ready(): Promise<void> {
    this.gateway.dispatch(GatewayDispatchEvents.Ready, {
      user: { id: ME, username: 'mate' },
      application: { id: APP },
      guilds: [{ id: GUILD }],
    });
    await settle();
  }

  /** The owner mentions mate in the allowed channel; returns the message id. */
  mention(content: string): string {
    return this.message(CHANNEL, `<@${ME}> ${content}`, [{ id: ME }]);
  }

  /** The owner writes in a thread, as history shows it too. */
  say(threadId: string, content: string): string {
    this.api.post(threadId, content, OWNER);
    return this.message(threadId, content, []);
  }

  /** The owner presses a thread's Stop button. */
  stop(key: string): void {
    this.gateway.dispatch(GatewayDispatchEvents.InteractionCreate, {
      id: `i-${++serial}`,
      token: 'tok',
      type: InteractionType.MessageComponent,
      data: {
        component_type: ComponentType.Button,
        custom_id: `${STOP_PREFIX}${key}`,
      },
      member: { user: { id: OWNER } },
    });
  }

  private message(
    channelId: string,
    content: string,
    mentions: { id: string }[],
  ): string {
    const id = `m-${++serial}`;
    this.gateway.dispatch(GatewayDispatchEvents.MessageCreate, {
      id,
      guild_id: GUILD,
      channel_id: channelId,
      author: { id: OWNER },
      content,
      mentions,
    });
    return id;
  }
}

export async function eventually(
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
