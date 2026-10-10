/**
 * The composition: what `Mate` builds from its edges, what it runs without,
 * and the order it stops in, seen at the edges it was given.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from '@earendil-works/pi-ai';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
} from '@earendil-works/pi-ai/providers/faux';
import type { SQL } from 'bun';
import type { BrainConfig } from '../src/config.ts';
import { PostgresCredentialStore } from '../src/credential-store.ts';
import { CUSTODIAN_INTERVAL_MS } from '../src/custodian.ts';
import type { KubeConfig } from '../src/kube.ts';
import { Mate, RETENTION_SWEEP_MS, type SlackSide } from '../src/mate.ts';
import { MCP_RETRY_MS } from '../src/mcp.ts';
import { CHATGPT_PROVIDER } from '../src/model.ts';
import { CHATGPT } from '../src/notices.ts';
import { SPARE_SWEEP_MS } from '../src/sandboxes.ts';
import { threadKey } from '../src/surface.ts';
import { withDatabase } from './db.ts';
import { FakeMcp } from './fake-mcp.ts';
import { FakeKube } from './fakeapi.ts';
import { FakeSlack, FakeSurface } from './fakesurface.ts';
import { cleanUp, tempDir } from './hands-support.ts';
import {
  CHANNEL,
  type ConfigOverrides,
  DiscordDriver,
  eventually,
  fauxModel,
  ME,
  mateConfig,
  RealClock,
  type TestDatabase,
  testDatabase,
} from './mate-support.ts';
import {
  discordRef,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';
import { ADMIN_CRT, talosconfig } from './talos-certs.ts';

const database = withDatabase();
const SLACK_USER = 'U0OWNER';
const SLACK_CHANNEL = 'C0OPS';
const ACCOUNT = 'acct-test';
const DAY_MS = 86_400_000;
const CHATGPT_PRIMARY: Partial<BrainConfig> = {
  model: 'openai-codex/gpt-6-sol',
  thinking: 'medium',
};
// 20:00 in Halifax, after the custodian's 18:00.
const EVENING = Date.UTC(2026, 5, 15, 23);
// 09:00 in Halifax, when the custodian only waits.
const MORNING = Date.UTC(2026, 5, 15, 12);

/** A clock that reads `from` at its start, and runs at real speed. */
class ShiftedClock extends RealClock {
  private readonly offset: number;
  constructor(from: number) {
    super();
    this.offset = from - Date.now();
  }
  override now(): number {
    return Date.now() + this.offset;
  }
}

interface Booted {
  readonly mate: Mate;
  readonly discord: DiscordDriver;
  readonly api: FakeDiscord;
  readonly slack: FakeSlack;
  readonly db: TestDatabase;
  readonly log: RecordingLog;
  readonly metrics: RecordingInstruments;
  /** What each edge was asked to do, in order. */
  readonly events: string[];
}

interface BootOptions {
  config?: ConfigOverrides;
  /** The pool, or `null` for a database with none. */
  sql?: SQL | null;
  slack?: 'open' | 'failing';
  /** Faux by default; `production` registers OpenCode Go and ChatGPT. */
  models?: FauxResponseStep[] | 'production';
  clock?: RealClock;
  kube?: KubeConfig;
  drainMs?: number;
}

const booted: { mate: Mate; clock: RealClock }[] = [];
const fakes: FakeKube[] = [];

beforeEach(async () => {
  const { sql } = database();
  await sql`DELETE FROM mate_threads`;
  await sql`DELETE FROM mate_credentials`;
  await sql`DELETE FROM mate_custodian_runs`;
});

afterEach(async () => {
  for (const { mate, clock } of booted.splice(0)) {
    await mate.stop();
    clock.stop();
  }
  for (const fake of fakes.splice(0)) await fake.close();
  globalThis.fetch = realFetch;
  await cleanUp();
});

function cluster(): KubeConfig {
  const fake = new FakeKube();
  fakes.push(fake);
  return fake.config();
}

function slackSide(events: string[], api: FakeSlack): SlackSide {
  const surface = new FakeSurface(
    'U0MATE',
    new Set([SLACK_USER]),
    new Set([SLACK_CHANNEL]),
  );
  return {
    api,
    listener: {
      async start(threads) {
        events.push('slack.start');
        await threads.add(surface);
      },
      stop: () => void events.push('slack.stop'),
      close: async () => void events.push('slack.close'),
    },
  };
}

async function boot(options: BootOptions = {}): Promise<Booted> {
  const clock = options.clock ?? new RealClock();
  const log = new RecordingLog();
  const metrics = new RecordingInstruments();
  const events: string[] = [];
  const api = new FakeDiscord(ME);
  const discord = new DiscordDriver(api, clock, log);
  const slack = new FakeSlack();
  const db = testDatabase(
    options.sql === undefined ? database().sql : options.sql,
  );
  db.onClose = () => void events.push('database.close');
  let providers: Provider[] | undefined;
  if (options.models !== 'production') {
    const model = fauxModel();
    model.respond(...(options.models ?? []));
    providers = [model.provider];
  }
  const slackConfig = options.slack
    ? {
        botToken: 'xoxb',
        appToken: 'xapp',
        teamId: 'T0TEAM',
        allowedUserIds: new Set([SLACK_USER]),
        allowedChannelIds: new Set([SLACK_CHANNEL]),
      }
    : null;
  const mate = new Mate({
    config: mateConfig({ slack: slackConfig, ...options.config }),
    clock,
    log,
    metrics,
    kube: options.kube ?? cluster(),
    database: db,
    surfaces: {
      discord: {
        start: (threads) => discord.listener.start(threads),
        stop: () => {
          events.push('discord.stop');
          discord.listener.stop();
        },
        close: async () => {
          events.push('discord.close');
          await discord.listener.close();
        },
      },
      slack: !options.slack
        ? null
        : options.slack === 'open'
          ? async () => slackSide(events, slack)
          : async () => {
              throw new Error('invalid_auth');
            },
    },
    ...(providers ? { providers } : {}),
    tuning: {
      threads: { editCadenceMs: 20, runGraceMs: 20 },
      drainMs: options.drainMs ?? 0,
    },
  });
  booted.push({ mate, clock });
  await mate.start();
  await discord.ready();
  await eventually(() => log.of('ready').length > 0, 'the Discord surface');
  return { mate, discord, api, slack, db, log, metrics, events };
}

/** The fields of the one 'mate starting' line. */
function starting(log: RecordingLog): Record<string, unknown> {
  const [entry] = log.of('mate starting');
  return entry?.fields ?? {};
}

/** Mentions mate and returns the thread it opens. */
async function mention(one: Booted, content: string) {
  const before = one.api.threads.length;
  const message = one.discord.mention(content);
  await eventually(() => one.api.threads.length > before, 'the thread to open');
  return { message, threadId: one.api.threads[before]?.id as string };
}

/** Mentions mate and returns what the thread shows once the turn is marked. */
async function asks(one: Booted, content: string): Promise<string[]> {
  const { message, threadId } = await mention(one, content);
  await eventually(
    () => one.api.reactionsOn(CHANNEL, message).some((r) => r !== '👀'),
    'the answer',
  );
  return one.api.contentsIn(threadId);
}

const realFetch = globalThis.fetch;

function jwt(n: number): string {
  const payload = btoa(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT },
    }),
  );
  return `${btoa('{"alg":"none"}')}.${payload}.SECRET-access-${n}`;
}

/** auth.openai.com as pi calls it; every other host goes out as usual. */
class FakeOpenAI {
  readonly paths: string[] = [];
  /** While set, a refresh waits on it. */
  refreshGate: Promise<void> | null = null;
  private issued = 0;

  install(): void {
    globalThis.fetch = (async (input: string | URL | Request, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'auth.openai.com') return realFetch(input, init);
      this.paths.push(url.pathname);
      switch (url.pathname) {
        case '/api/accounts/deviceauth/usercode':
          return Response.json({
            device_auth_id: 'dev-1',
            user_code: 'QX7R-M4ZP',
            interval: '1',
          });
        case '/api/accounts/deviceauth/token':
          // The code is never entered: the poll waits until it is cut off.
          return new Promise<Response>((_, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
          });
        case '/oauth/token':
          if (this.refreshGate) await this.refreshGate;
          this.issued += 1;
          return Response.json({
            access_token: jwt(this.issued),
            refresh_token: `rt_SECRET_${this.issued}`,
            expires_in: 864_000,
          });
        default:
          throw new Error(`unexpected fetch to ${url.href}`);
      }
    }) as typeof fetch;
  }
}

function gate() {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('stopping', () => {
  test('stops Slack, Discord, the custodian and the spare sweep first, then closes Discord, Slack and the database in turn after the drain', async () => {
    const clock = new ShiftedClock(MORNING);
    let asked = false;
    const one = await boot({
      slack: 'open',
      drainMs: 300,
      clock,
      config: {
        custodianChannel: SLACK_CHANNEL,
        // Apart from the custodian's interval.
        sandbox: { turnTimeoutMs: 120_000 },
      },
      models: [
        (_context, options) =>
          new Promise((resolve) => {
            asked = true;
            options?.signal?.addEventListener('abort', () =>
              resolve(fauxAssistantMessage('')),
            );
          }),
      ],
    });
    const { message, threadId } = await mention(one, 'take your time');
    const key = threadKey(discordRef(threadId, CHANNEL));
    await eventually(() => asked, 'the running turn');
    await eventually(
      () =>
        [CUSTODIAN_INTERVAL_MS, SPARE_SWEEP_MS].every((ms) =>
          clock.armed().includes(ms),
        ),
      'the custodian and the sweep',
    );

    const stopping = one.mate.stop();
    await settle();
    expect(one.events).toEqual(['slack.start', 'slack.stop', 'discord.stop']);
    // Nothing starts a turn while the drain waits.
    expect(clock.armed()).not.toContain(CUSTODIAN_INTERVAL_MS);
    expect(clock.armed()).not.toContain(SPARE_SWEEP_MS);

    // The gateway has left, so a Stop pressed during the drain is not
    // delivered; the drain's own deadline abandons the turn.
    one.discord.stop(key);
    await stopping;
    expect(one.api.reactionsOn(CHANNEL, message)).not.toContain('⏹️');
    // Abandoned, not cancelled: the turn stays open for the next process.
    expect(one.metrics.turns).toEqual([]);
    await one.db.sql?.unsafe('TRUNCATE mate_threads, pi_sessions CASCADE');
    expect(one.events).toEqual([
      'slack.start',
      'slack.stop',
      'discord.stop',
      'discord.close',
      'slack.close',
      'database.close',
    ]);
    expect(one.discord.gateway.destroys).toBe(1);
  });

  test('leaves no timer armed, as a caller that never exits needs', async () => {
    const mcp = new FakeMcp({
      tools: [{ name: 'deploy', inputSchema: { type: 'object' } }],
    }).start();
    try {
      const clock = new ShiftedClock(MORNING);
      const one = await boot({
        slack: 'open',
        clock,
        config: {
          custodianChannel: SLACK_CHANNEL,
          brain: {
            sessionRetentionDays: 30,
            mcpServers: [{ name: 'kthx', url: mcp.url, token: null }],
          },
        },
      });
      // The custodian, the wakes and the MCP bridge each tick every minute.
      await eventually(
        () => clock.armed().filter((ms) => ms === MCP_RETRY_MS).length === 3,
        'the custodian, the wakes and the MCP bridge',
      );
      expect(clock.armed()).toContain(SPARE_SWEEP_MS);
      expect(clock.armed()).toContain(RETENTION_SWEEP_MS);

      await one.mate.stop();

      expect(clock.armed()).toEqual([]);
    } finally {
      await mcp.stop();
    }
  });

  test('keeps every session when no retention is set', async () => {
    const clock = new ShiftedClock(MORNING);
    const one = await boot({
      clock,
      config: { brain: { sessionRetentionDays: 0 } },
    });
    await eventually(
      () => clock.armed().includes(SPARE_SWEEP_MS),
      'the spare sweep',
    );

    expect(clock.armed()).not.toContain(RETENTION_SWEEP_MS);

    await one.mate.stop();
  });

  test('a sign-in waiting for its code hears that it no longer works before Discord closes', async () => {
    const openai = new FakeOpenAI();
    openai.install();
    const one = await boot({
      models: 'production',
      config: { brain: CHATGPT_PRIMARY },
    });
    const { threadId } = await mention(one, 'chatgpt login');
    await eventually(
      () => openai.paths.includes('/api/accounts/deviceauth/token'),
      'the code to be polled',
    );
    let shownAtClose: string[] = [];
    one.events.length = 0;
    const close = one.discord.listener.close;
    one.discord.listener.close = async () => {
      shownAtClose = one.api.contentsIn(threadId);
      await close();
    };

    await one.mate.stop();

    expect(one.api.dms).toHaveLength(1);
    expect(shownAtClose.at(-1)).toStartWith(CHATGPT.interrupted);
    expect(one.events).toEqual([
      'discord.stop',
      'discord.close',
      'database.close',
    ]);
  });

  test('a rotated ChatGPT token still saves when stop lands mid-refresh', async () => {
    const seeded = new PostgresCredentialStore({
      db: { sql: database().sql, up: () => true },
      log: new RecordingLog(),
    });
    // Inside the keeper's two-day margin, so the boot check rotates it.
    await seeded.modify(CHATGPT_PROVIDER, async () => ({
      type: 'oauth',
      access: jwt(0),
      refresh: 'rt_SECRET_0',
      expires: Date.now() + DAY_MS,
      accountId: ACCOUNT,
    }));
    await seeded.close();
    const openai = new FakeOpenAI();
    const refresh = gate();
    openai.refreshGate = refresh.wait;
    openai.install();
    const one = await boot({
      models: 'production',
      config: { brain: CHATGPT_PRIMARY },
    });
    await eventually(
      () => openai.paths.includes('/oauth/token'),
      'the boot refresh',
    );
    let savedAtClose: unknown = null;
    one.db.onClose = async () => {
      one.events.push('database.close');
      const [row] = await database()
        .sql`SELECT credential FROM mate_credentials WHERE provider = ${CHATGPT_PROVIDER}`;
      savedAtClose = JSON.parse(row.credential);
    };

    const stopping = one.mate.stop();
    await eventually(
      () => one.events.includes('discord.close'),
      'the gateway to close',
    );
    await Bun.sleep(50);
    expect(one.events).not.toContain('database.close');

    refresh.open();
    await stopping;
    expect(one.events.at(-1)).toBe('database.close');
    expect(savedAtClose).toMatchObject({ refresh: 'rt_SECRET_1' });
  });
});

describe('a degraded start', () => {
  test('answers on Discord alone when Slack cannot be opened', async () => {
    const one = await boot({
      slack: 'failing',
      models: [fauxAssistantMessage('still here')],
    });
    expect(
      one.log.of('slack could not be opened; answering on Discord alone'),
    ).toEqual([
      expect.objectContaining({
        level: 'error',
        fields: { error: 'invalid_auth' },
      }),
    ]);
    expect(await asks(one, 'hello')).toEqual(['still here']);
    await one.mate.stop();
    expect(one.events).toEqual([
      'discord.stop',
      'discord.close',
      'database.close',
    ]);
  });

  test.each([
    ['an unreadable key', '5027196', 'no such file'],
    ['an App id that is not a number', 'clanky-bot', 'not a numeric app id'],
  ])('runs without the GitHub App given %s', async (_, appId, error) => {
    const one = await boot({
      config: {
        githubApp: {
          appId,
          keyFile: '/nonexistent/github-app/private-key',
          owner: 'jonpulsifer',
          repo: 'infra',
        },
      },
      models: [fauxAssistantMessage('no pushing today')],
    });
    const [entry] = one.log.of('the GitHub App could not be opened');
    expect(entry?.level).toBe('error');
    expect(entry?.fields?.keyFile).toBe('/nonexistent/github-app/private-key');
    expect(String(entry?.fields?.error).toLowerCase()).toContain(error);
    expect(one.metrics.appReady).toBe(false);
    expect(one.log.of('github app ready')).toEqual([]);
    expect(one.log.of('github app NOT ready')).toEqual([]);
    expect(await asks(one, 'hello')).toEqual(['no pushing today']);
  });

  test('runs without host access when the SSH key cannot be read', async () => {
    const one = await boot({
      config: { sshKeyFile: '/nonexistent/ssh/id_ed25519' },
      models: [fauxAssistantMessage('no hosts today')],
    });
    expect(one.log.of('the sandbox SSH key could not be read')).toEqual([
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({
          keyFile: '/nonexistent/ssh/id_ed25519',
        }),
      }),
    ]);
    expect(await asks(one, 'hello')).toEqual(['no hosts today']);
  });

  test('runs without node access until the talosconfig exists, quietly', async () => {
    const one = await boot({
      config: { talosconfigFile: '/nonexistent/talos/config' },
      models: [fauxAssistantMessage('no nodes yet')],
    });
    expect(one.log.of('no sandbox talosconfig yet')).toHaveLength(1);
    expect(one.log.of('the sandbox talosconfig could not be read')).toEqual([]);
    expect(await asks(one, 'hello')).toEqual(['no nodes yet']);
  });

  test('refuses a talosconfig that grants more than os:reader, and still answers', async () => {
    const file = join(tempDir('talos'), 'config');
    writeFileSync(file, talosconfig({ folly: ADMIN_CRT }));
    const one = await boot({
      config: { talosconfigFile: file },
      models: [fauxAssistantMessage('no admin for you')],
    });
    expect(one.log.of('the sandbox talosconfig could not be read')).toEqual([
      expect.objectContaining({
        level: 'error',
        fields: expect.objectContaining({ file }),
      }),
    ]);
    expect(await asks(one, 'hello')).toEqual(['no admin for you']);
  });

  test('starts and answers when the hands cannot count the standing sandboxes', async () => {
    const refusing = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ message: 'down' }, { status: 503 }),
    });
    try {
      const one = await boot({
        kube: {
          server: `http://127.0.0.1:${refusing.port}`,
          namespace: 'mate',
          credentials: async () => ({ token: 'fake-token' }),
        },
        models: [fauxAssistantMessage('chat still works')],
      });
      expect(
        one.log.of('could not count the standing sandboxes at boot'),
      ).toHaveLength(1);
      expect(one.log.of('mate starting')).toHaveLength(1);
      expect(await asks(one, 'hello')).toEqual(['chat still works']);
    } finally {
      refusing.stop(true);
    }
  });
});

describe('the custodian', () => {
  const custodian = {
    custodianChannel: SLACK_CHANNEL,
  } satisfies ConfigOverrides;

  test('posts the day’s root with a channel, Slack and a database', async () => {
    const one = await boot({
      slack: 'open',
      config: custodian,
      clock: new ShiftedClock(EVENING),
      models: [fauxAssistantMessage('all healthy')],
    });
    await eventually(
      () => one.slack.calls.some((call) => call.call === 'post'),
      'the root',
    );
    expect(one.slack.calls[0]).toMatchObject({
      call: 'post',
      channel: SLACK_CHANNEL,
      threadTs: '',
      text: 'Daily homelab check · 2026-06-15 (Atlantic)',
    });
    expect(
      one.log.of('custodian disabled: Slack or database unavailable'),
    ).toEqual([]);
  });

  test.each([
    ['Slack cannot be opened', { slack: 'failing' }],
    ['the database has no pool', { slack: 'open', sql: null }],
  ] as const)('is off, and says so, when %s', async (_, options) => {
    const one = await boot({
      ...options,
      config: custodian,
      clock: new ShiftedClock(EVENING),
    });
    expect(
      one.log.of('custodian disabled: Slack or database unavailable'),
    ).toHaveLength(1);
    await Bun.sleep(50);
    expect(one.slack.calls).toEqual([]);
  });

  test('is off, and quiet, with no channel', async () => {
    const one = await boot({
      slack: 'open',
      clock: new ShiftedClock(EVENING),
    });
    await Bun.sleep(50);
    expect(one.slack.calls).toEqual([]);
    expect(
      one.log.of('custodian disabled: Slack or database unavailable'),
    ).toEqual([]);
  });
});

describe('the ChatGPT sign-in', () => {
  test('is kept for a ChatGPT primary, whose commands answer in the thread', async () => {
    const one = await boot({
      models: 'production',
      config: { brain: CHATGPT_PRIMARY },
    });
    expect(starting(one.log)).toMatchObject({
      model: 'openai-codex/gpt-6-sol',
      chatgpt: true,
    });
    const { message, threadId } = await mention(one, 'chatgpt status');
    await eventually(
      () => one.api.contentsIn(threadId).length > 0,
      'the status',
    );
    expect(one.api.contentsIn(threadId)[0]).toStartWith(CHATGPT.status);
    // A command takes no turn, so nothing marks its message.
    expect(one.api.reactionsOn(CHANNEL, message)).toEqual([]);
  });

  test('is not built for a primary on another provider, so `chatgpt` is a prompt', async () => {
    const one = await boot({
      models: [fauxAssistantMessage('a model answer')],
    });
    expect(starting(one.log)).toMatchObject({
      model: 'faux/faux',
      chatgpt: false,
    });
    expect(await asks(one, 'chatgpt status')).toEqual(['a model answer']);
  });

  test('is not built for a ChatGPT primary with no database pool', async () => {
    const one = await boot({
      models: 'production',
      config: { brain: CHATGPT_PRIMARY },
      sql: null,
    });
    expect(starting(one.log)).toMatchObject({ store: 'down', chatgpt: false });
  });
});
