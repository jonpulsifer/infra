/**
 * The ChatGPT sign-in through pi's own device flow, refresh and Codex request.
 * A fake fetch plays OpenAI, and any other host fails the test.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import type { ModelSetup } from '../src/brain-inputs.ts';
import {
  CHECK_MS,
  ChatgptAccount,
  ChatgptKeeper,
  LOGIN_TIMEOUT_MS,
  PAUSE_MAX_MINUTES,
  parseChatgptCommand,
  RETRY_MS,
} from '../src/chatgpt.ts';
import { PostgresCredentialStore } from '../src/credential-store.ts';
import {
  CHATGPT_PROVIDER,
  chatgptModel,
  createModelSetup,
} from '../src/model.ts';
import { CHATGPT, isNotice, STORE_DOWN } from '../src/notices.ts';
import type { Surface, ThreadRef } from '../src/surface.ts';
import { withDatabase } from './db.ts';
import { FakeSurface } from './fakesurface.ts';
import {
  discordRef,
  FakeClock,
  FakeDiscord,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const database = withDatabase();
const ME = '900000000000000001';
const OWNER = '308072071949320204';
const CHANNEL = '1509024937422356532';
const THREAD = '1509024937422356777';
const USER_CODE = 'QX7R-M4ZP';
const ACCOUNT = 'acct-test';
const DAY_MS = 86_400_000;
const TEN_DAYS_S = 864_000;
const ref: ThreadRef = discordRef(THREAD, CHANNEL);
const DEPLOYED = 'openai-codex/gpt-6-sol';
const FALLBACK = 'opencode-go/qwen3.8-max';

function jwt(n: number): string {
  const payload = btoa(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT },
    }),
  );
  return `${btoa('{"alg":"none"}')}.${payload}.SECRET-access-${n}`;
}

type Outcome = 'ok' | 'network' | number;

interface Call {
  host: string;
  path: string;
  grant?: string;
  authorization?: string;
}

/** OpenAI's auth and Codex endpoints, as pi calls them. */
class FakeOpenAI {
  readonly calls: Call[] = [];
  readonly hosts = new Set<string>();
  usercode: Outcome = 'ok';
  exchange: Outcome = 'ok';
  refresh: Outcome = 'ok';
  codex: Outcome = 'ok';
  /** While set, a device poll waits on it; its value is the poll's answer. */
  pollGate: Promise<'complete' | 'pending'> | null = null;
  private issued = 0;

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'https:' || url.port !== '') {
      throw new Error(`mate reached ${url.origin}, which is not HTTPS on 443`);
    }
    this.hosts.add(url.hostname);
    const headers = new Headers(init?.headers);
    const body =
      init?.body instanceof URLSearchParams || typeof init?.body === 'string'
        ? String(init.body)
        : '';
    const grant = new URLSearchParams(body).get('grant_type') ?? undefined;
    this.calls.push({
      host: url.hostname,
      path: url.pathname,
      ...(grant ? { grant } : {}),
      ...(headers.get('authorization')
        ? { authorization: headers.get('authorization') ?? '' }
        : {}),
    });
    const at = `${url.hostname}${url.pathname}`;
    switch (at) {
      case 'auth.openai.com/api/accounts/deviceauth/usercode':
        return this.answer(this.usercode, () =>
          Response.json({
            device_auth_id: 'dev-1',
            user_code: USER_CODE,
            interval: '1',
          }),
        );
      case 'auth.openai.com/api/accounts/deviceauth/token':
        return this.poll(init?.signal ?? undefined);
      case 'auth.openai.com/oauth/token':
        return this.answer(
          grant === 'refresh_token' ? this.refresh : this.exchange,
          () => this.tokens(),
        );
      case 'chatgpt.com/backend-api/codex/responses':
        return this.answer(this.codex, () => pong());
      default:
        throw new Error(`unexpected fetch to ${url.origin}${url.pathname}`);
    }
  };

  of(path: string): Call[] {
    return this.calls.filter((call) => call.path === path);
  }

  private async poll(signal: AbortSignal | undefined): Promise<Response> {
    const gate = this.pollGate;
    const answer = gate
      ? await new Promise<'complete' | 'pending'>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
          void gate.then(resolve);
        })
      : 'complete';
    if (answer === 'pending') {
      return Response.json({ error: 'pending' }, { status: 403 });
    }
    return Response.json({
      authorization_code: 'SECRET-authorization-code',
      code_verifier: 'SECRET-verifier',
    });
  }

  private tokens(): Response {
    this.issued += 1;
    return Response.json({
      access_token: jwt(this.issued),
      refresh_token: `rt_SECRET_${this.issued}`,
      expires_in: TEN_DAYS_S,
    });
  }

  private answer(outcome: Outcome, ok: () => Response): Response {
    if (outcome === 'ok') return ok();
    if (outcome === 'network') throw new TypeError('fetch failed');
    return new Response(
      JSON.stringify({
        error: {
          code: 'refused',
          message: `refused rt_SECRET_body ${outcome}`,
        },
      }),
      { status: outcome, headers: { 'content-type': 'application/json' } },
    );
  }
}

/** A Codex answer over SSE, the shape pi parses. */
function pong(): Response {
  const events = [
    { type: 'response.created', response: { id: 'resp_1' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] },
    },
    { type: 'response.output_text.delta', output_index: 0, delta: 'pong' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'pong' }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    },
  ];
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const original = globalThis.fetch;
let clock: FakeClock;
let log: RecordingLog;
let metrics: RecordingInstruments;
let openai: FakeOpenAI;
let up: boolean;
let store: PostgresCredentialStore;
let setup: ModelSetup;
let keeper: ChatgptKeeper;
let account: ChatgptAccount;
let discord: FakeDiscord;
let surface: Surface;
let reads: number;

beforeEach(async () => {
  clock = new FakeClock(Date.now());
  log = new RecordingLog();
  metrics = new RecordingInstruments();
  openai = new FakeOpenAI();
  globalThis.fetch = openai.fetch as typeof fetch;
  up = true;
  reads = 0;
  await database().sql`DELETE FROM mate_credentials`;
  store = new PostgresCredentialStore({
    db: { sql: database().sql, up: () => up },
    log,
    clock,
    metrics,
  });
  wire(DEPLOYED, FALLBACK);
  discord = new FakeDiscord(ME);
  surface = discord.surface({
    me: ME,
    allowedUserIds: new Set([OWNER]),
    allowedChannelIds: new Set([CHANNEL]),
    clock,
  });
});

/** mate's model setup, keeper and commands over the one store. */
function wire(spec: string, fallbackSpec: string | null): void {
  keeper?.stop();
  setup = createModelSetup({
    spec,
    thinking: 'medium',
    fallbackSpec,
    keyFile: '/nonexistent/opencode-key',
    credentials: store,
    log,
    clock,
    metrics,
  });
  keeper = new ChatgptKeeper({
    models: setup.direct,
    credentials: {
      read: (id) => {
        reads += 1;
        return store.read(id);
      },
      onChange: (listener) => store.onChange(listener),
    },
    clock,
    log,
    metrics,
    router: setup.router,
  });
  account = new ChatgptAccount({
    models: setup.direct,
    keeper,
    credentials: store,
    model: chatgptModel(setup),
    lane: { model: setup.model, thinking: setup.thinking },
    router: setup.router,
    clock,
    log,
  });
}

afterEach(async () => {
  keeper.stop();
  await account.stop();
  setSystemTime();
  await store.close();
  globalThis.fetch = original;
});

function command(text: string, on: Surface = surface): Promise<void> {
  const parsed = account.parse(text);
  if (!parsed) throw new Error(`not a command: ${text}`);
  return parsed.run({ surface: on, thread: ref, authorId: OWNER });
}

/** Everything mate said in the thread. */
const said = () => discord.contentsIn(THREAD);

/** Nothing a thread, a log or a metric holds carries a token or the code. */
function expectNothingSecret(): void {
  const seen = JSON.stringify([said(), log.entries, metrics.chatgptStates]);
  expect(seen).not.toContain('SECRET');
  expect(seen).not.toContain(USER_CODE);
}

async function signIn(expiresInDays = 10): Promise<void> {
  const now = Date.now();
  await store.modify(CHATGPT_PROVIDER, async () => ({
    type: 'oauth',
    access: jwt(0),
    refresh: 'rt_SECRET_0',
    expires: now + expiresInDays * DAY_MS,
    accountId: ACCOUNT,
  }));
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('it never happened');
    await Bun.sleep(5);
  }
}

/** Moves mate's clock on, and pi's `Date.now()` with it. */
async function later(ms: number): Promise<void> {
  setSystemTime(new Date(clock.now() + ms));
  await clock.advance(ms);
}

describe('the command', () => {
  test.each([
    ['chatgpt login', { kind: 'login' }],
    ['ChatGPT  STATUS', { kind: 'status' }],
    [' chatgpt logout ', { kind: 'logout' }],
    ['chatgpt resume', { kind: 'resume' }],
    ['chatgpt pause', { kind: 'pause', minutes: 60 }],
    ['chatgpt pause 5', { kind: 'pause', minutes: 5 }],
    ['chatgpt pause 90m', { kind: 'pause', minutes: 90 }],
    ['chatgpt pause 99999', { kind: 'pause', minutes: PAUSE_MAX_MINUTES }],
    ['chatgpt pause 0', { kind: 'pause', minutes: 1 }],
  ])('%s', (text, parsed) => {
    expect(parseChatgptCommand(text)).toEqual(parsed as never);
  });

  test.each([
    'chatgpt',
    'chatgpt login now',
    'please chatgpt status',
    'chatgpt pause soon',
    'chatgpt pause 123456',
    'what does chatgpt status say?',
  ])('%s is a prompt', (text) => {
    expect(parseChatgptCommand(text)).toBeNull();
  });
});

describe('signing in', () => {
  test('whispers the code, says only that it did, then proves the sign-in with one request', async () => {
    await command('chatgpt login');

    expect(discord.dms).toHaveLength(1);
    const [dm] = discord.dms;
    expect(dm?.userId).toBe(OWNER);
    expect(dm?.content).toContain('https://auth.openai.com/codex/device');
    expect(dm?.content).toContain(USER_CODE);
    expect(dm?.content).toMatch(/The code expires at \d\d:\d\d UTC\.$/);
    expect(said()).toEqual([
      `${CHATGPT.codeSent} by DM. It works for 15 minutes.`,
      `${CHATGPT.signedIn}. A test request to openai-codex/gpt-6-sol answered in 0.0 s, so turns use it from now on, with opencode-go/qwen3.8-max as the fallback.`,
    ]);
    expect(openai.calls.map((call) => call.path)).toEqual([
      '/api/accounts/deviceauth/usercode',
      '/api/accounts/deviceauth/token',
      '/oauth/token',
      '/backend-api/codex/responses',
    ]);
    expect(openai.of('/backend-api/codex/responses')[0]?.authorization).toBe(
      `Bearer ${jwt(1)}`,
    );
    const [row] = await database()
      .sql`SELECT credential FROM mate_credentials WHERE provider = ${CHATGPT_PROVIDER}`;
    expect(JSON.parse(row.credential)).toMatchObject({
      type: 'oauth',
      refresh: 'rt_SECRET_1',
      accountId: ACCOUNT,
    });
    expect(metrics.chatgptStates.at(-1)).toEqual({
      signedIn: true,
      expiresAt: expect.any(Number),
    });
    for (const line of said()) expect(isNotice(line)).toBe(true);
    expectNothingSecret();
  });

  test('with turns on OpenCode Go, a sign-in says that turns do not use it yet', async () => {
    wire(FALLBACK, null);
    await command('chatgpt login');
    expect(said().at(-1)).toBe(
      `${CHATGPT.signedIn}. A test request to openai-codex/gpt-6-sol answered in 0.0 s. MATE_MODEL is opencode-go/qwen3.8-max, so turns do not use it yet.`,
    );
    openai.codex = 403;
    await command('chatgpt login');
    expect(said().at(-1)).toBe(
      `${CHATGPT.proofFailed} a test request to openai-codex/gpt-6-sol failed (HTTP 403). mate keeps answering with opencode-go/qwen3.8-max; \`chatgpt status\` says more.`,
    );
  });

  test('the test request reaches ChatGPT even while the router sends turns elsewhere', async () => {
    setup.router?.pause(clock.now() + 60 * 60_000);
    await command('chatgpt login');
    expect(openai.of('/backend-api/codex/responses')).toHaveLength(1);
    expect(said().at(-1)).toStartWith(`${CHATGPT.signedIn}. A test request`);
  });

  test('on Slack the code goes to a message only the owner sees, in the channel', async () => {
    const slack = new FakeSurface(ME, new Set([OWNER]), new Set([CHANNEL]));
    await command('chatgpt login', slack);
    expect(slack.whispers).toEqual([
      {
        channelId: CHANNEL,
        userId: OWNER,
        text: expect.stringContaining(USER_CODE),
      },
    ]);
    const lines = slack.linesIn(THREAD);
    expect(lines[0]).toBe(
      `${CHATGPT.codeSent} that only you can see, in this channel. It works for 15 minutes.`,
    );
    expect(JSON.stringify(slack.posted)).not.toContain(USER_CODE);
  });

  test('a code that cannot go privately is never shown, and the sign-in stops', async () => {
    discord.failDirectMessages = Object.assign(
      new Error('Cannot send messages to this user'),
      { code: 50007 },
    );
    openai.pollGate = new Promise(() => {});
    await command('chatgpt login');
    expect(discord.dms).toEqual([]);
    expect(said()).toEqual([
      `${CHATGPT.notSent} by DM, so mate cancelled the sign-in. Allow direct messages from members of this server, then say \`chatgpt login\` again.`,
    ]);
    expect(openai.of('/oauth/token')).toEqual([]);
    expect(await store.read(CHATGPT_PROVIDER)).toBeUndefined();
    expect(
      log.of('the ChatGPT sign-in code could not be sent privately'),
    ).toEqual([
      expect.objectContaining({ fields: { error: 'Error', code: 50007 } }),
    ]);
    expectNothingSecret();
  });

  test('a surface that cannot whisper starts no sign-in', async () => {
    const plain = { ...surface, whisper: undefined };
    await command('chatgpt login', plain);
    expect(said()).toEqual([
      `${CHATGPT.noWhisper}, so it did not start a sign-in.`,
    ]);
    expect(openai.calls).toEqual([]);
  });

  test('one sign-in at a time: a second login gets the one waiting', async () => {
    let enter = (_answer: 'complete') => {};
    openai.pollGate = new Promise((resolve) => {
      enter = resolve;
    });
    const first = command('chatgpt login');
    await until(() => said().length === 1);
    await command('chatgpt login');
    expect(said()[1]).toMatch(
      new RegExp(`^${CHATGPT.codeWaiting}, until \\d\\d:\\d\\d UTC\\.$`),
    );
    expect(openai.of('/api/accounts/deviceauth/usercode')).toHaveLength(1);
    enter('complete');
    await first;
    expect(said().at(-1)).toStartWith(CHATGPT.signedIn);
  });

  test('a code nobody enters expires, and the next login may start', async () => {
    openai.pollGate = new Promise(() => {});
    const waiting = command('chatgpt login');
    await until(() => said().length === 1);
    await clock.advance(LOGIN_TIMEOUT_MS);
    await waiting;
    expect(said().at(-1)).toBe(
      `${CHATGPT.codeExpired}. Say \`chatgpt login\` for a new one.`,
    );
    openai.pollGate = null;
    await command('chatgpt login');
    expect(said().at(-1)).toStartWith(CHATGPT.signedIn);
  });

  // pi polls to its own 15-minute deadline on Date.now(), before mate's backstop.
  test("a code that outlives pi's own poll deadline is said to have expired", async () => {
    let answer = (_answer: 'pending') => {};
    openai.pollGate = new Promise((resolve) => {
      answer = resolve;
    });
    const waiting = command('chatgpt login');
    await until(() => said().length === 1);
    setSystemTime(new Date(Date.now() + LOGIN_TIMEOUT_MS));
    answer('pending');
    await waiting;
    expect(said().at(-1)).toBe(
      `${CHATGPT.codeExpired}. Say \`chatgpt login\` for a new one.`,
    );
    expect(openai.of('/oauth/token')).toEqual([]);
    expect(clock.pendingTimers).toBe(0);
  });

  test('a restart while the code waits tells the thread before mate stops', async () => {
    openai.pollGate = new Promise(() => {});
    const waiting = command('chatgpt login');
    await until(() => said().length === 1);
    await account.stop();
    expect(said()).toEqual([
      `${CHATGPT.codeSent} by DM. It works for 15 minutes.`,
      `${CHATGPT.interrupted}. Say \`chatgpt login\` again for a new code.`,
    ]);
    await waiting;
    expect(await store.read(CHATGPT_PROVIDER)).toBeUndefined();
    for (const line of said()) expect(isNotice(line)).toBe(true);
  });

  test('a store mate cannot read starts no sign-in, so nobody enters a code for nothing', async () => {
    up = false;
    await command('chatgpt login');
    expect(said()).toEqual([STORE_DOWN]);
    expect(discord.dms).toEqual([]);
    expect(openai.calls).toEqual([]);
  });

  test('OpenAI refusing the device flow is said with its status', async () => {
    openai.usercode = 404;
    await command('chatgpt login');
    expect(said()).toEqual([
      `${CHATGPT.deviceRefused} (HTTP 404), which it does when device sign-in is off for the account.`,
    ]);
    expect(discord.dms).toEqual([]);
  });

  test('a failed token exchange is named by its status, never its body', async () => {
    openai.exchange = 400;
    await command('chatgpt login');
    expect(said().at(-1)).toBe(
      `${CHATGPT.failed}: the token exchange failed (HTTP 400).`,
    );
    expect(await store.read(CHATGPT_PROVIDER)).toBeUndefined();
    expectNothingSecret();
  });

  test('auth.openai.com out of reach is said so', async () => {
    openai.usercode = 'network';
    await command('chatgpt login');
    expect(said()).toEqual([
      `${CHATGPT.failed}: auth.openai.com could not be reached.`,
    ]);
  });

  test.each<[Outcome, string]>([
    [403, 'HTTP 403'],
    [429, "ChatGPT's usage limit is reached"],
    ['network', 'chatgpt.com could not be reached'],
  ])(
    'a test request answered %p is signed in, but says why it failed',
    async (outcome, why) => {
      openai.codex = outcome;
      await command('chatgpt login');
      expect(said().at(-1)).toBe(
        `${CHATGPT.proofFailed} a test request to openai-codex/gpt-6-sol failed (${why}). mate answers with opencode-go/qwen3.8-max while ChatGPT fails; \`chatgpt status\` says more.`,
      );
      expect(await store.read(CHATGPT_PROVIDER)).toBeDefined();
      await command('chatgpt status');
      expect(said().at(-1)).toContain(`The last test request failed (${why})`);
      expectNothingSecret();
    },
  );
});

describe('the keeper', () => {
  test('leaves a token with two days or more alone', async () => {
    await signIn(3);
    expect(await keeper.check()).toBe('fresh');
    expect(openai.calls).toEqual([]);
    expect(metrics.chatgptStates.at(-1)).toMatchObject({ signedIn: true });
  });

  test('rotates a token under two days, saves it, and checks again in six hours', async () => {
    await signIn(1);
    expect(await keeper.check()).toBe('refreshed');
    expect(openai.of('/oauth/token')).toEqual([
      expect.objectContaining({ grant: 'refresh_token' }),
    ]);
    const saved = await new PostgresCredentialStore({
      db: { sql: database().sql, up: () => true },
      log,
    }).read(CHATGPT_PROVIDER);
    expect(saved).toMatchObject({ refresh: 'rt_SECRET_1' });
    const state = keeper.state();
    expect(state.state === 'good' && state.expires).toBeGreaterThan(
      Date.now() + 9 * DAY_MS,
    );
    expect(metrics.chatgptStates.at(-1)).toEqual({
      signedIn: true,
      expiresAt: state.state === 'good' ? state.expires : -1,
    });
    const before = reads;
    await clock.advance(CHECK_MS - 1);
    expect(reads).toBe(before);
    await clock.advance(1);
    await until(() => reads === before + 1);
    expectNothingSecret();
  });

  test('checks once the store is up, never before', async () => {
    let open = () => {};
    keeper.start(
      new Promise<void>((resolve) => {
        open = resolve;
      }),
    );
    await settle();
    expect(reads).toBe(0);
    await signIn(5);
    open();
    await until(() => reads === 1);
    await until(() => keeper.state().state === 'good');
  });

  test.each([400, 401, 403])(
    'a refresh refused with %p signs mate out until the next login, and is not retried',
    async (status) => {
      await signIn(1);
      openai.refresh = status;
      expect(await keeper.check()).toBe('refused');
      expect(metrics.chatgptStates.at(-1)).toEqual({
        signedIn: false,
        expiresAt: null,
      });
      expect(await keeper.check()).toBe('refused');
      expect(openai.of('/oauth/token')).toHaveLength(1);
      // The access token may still work, but the owner's kill switch looks like this.
      expect(setup.router?.status().now).toMatchObject({
        route: 'fallback',
        reason: 'auth',
        retryAt: null,
      });
      await command('chatgpt status');
      expect(said().at(-1)).toMatch(
        /^ℹ️ ChatGPT: signed out, because OpenAI refused the token refresh at \d\d:\d\d UTC\. Say `chatgpt login` to sign in again\./,
      );
      await command('chatgpt login');
      expect(keeper.state().state).toBe('good');
      expect(metrics.chatgptStates.at(-1)).toMatchObject({ signedIn: true });
      expect(setup.router?.status().now).toEqual({ route: 'primary' });
      expectNothingSecret();
    },
  );

  test.each<Outcome>([500, 429, 'network'])(
    'a refresh that fails with %p keeps the token and tries again in 15 minutes',
    async (outcome) => {
      await signIn(1);
      openai.refresh = outcome;
      expect(await keeper.check()).toBe('transient');
      expect(metrics.chatgptStates.at(-1)).toMatchObject({ signedIn: true });
      openai.refresh = 'ok';
      await clock.advance(RETRY_MS);
      await until(() => openai.of('/oauth/token').length === 2);
      await until(() => {
        const state = keeper.state();
        return state.state === 'good' && state.expires > Date.now() + DAY_MS;
      });
      expect(await store.read(CHATGPT_PROVIDER)).toMatchObject({
        refresh: 'rt_SECRET_1',
      });
    },
  );

  test('chatgpt.com refusing the token asks for one rotation, which lets ChatGPT answer again', async () => {
    await signIn(5);
    const ask = () =>
      setup.models.completeSimple(
        setup.model,
        { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
        { transport: 'sse' },
      );
    openai.codex = 401;
    const refused = await ask();
    expect(refused.errorMessage).toStartWith(
      "mate's ChatGPT sign-in stopped working; opencode-go/qwen3.8-max: ",
    );
    await until(() => setup.router?.status().now.route === 'primary');
    expect(openai.of('/oauth/token')).toEqual([
      expect.objectContaining({ grant: 'refresh_token' }),
    ]);
    expect(await store.read(CHATGPT_PROVIDER)).toMatchObject({
      refresh: 'rt_SECRET_1',
    });

    // A token refused again right after its rotation is not the token's fault.
    await ask();
    await settle();
    expect(openai.of('/oauth/token')).toHaveLength(1);
    expect(setup.router?.status().now).toMatchObject({ reason: 'auth' });
    openai.codex = 'ok';
    expect((await ask()).errorMessage).toStartWith("mate's ChatGPT sign-in");
    expect(JSON.stringify(refused)).not.toContain('SECRET');
    expectNothingSecret();
  });

  test('chatgpt.com refusing the token its rotation gave signs mate out until the next login', async () => {
    await signIn(5);
    await keeper.check();
    const ask = () =>
      setup.models.completeSimple(
        setup.model,
        { messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }] },
        { transport: 'sse' },
      );
    openai.codex = 401;
    await ask();
    await until(() => setup.router?.status().now.route === 'primary');
    await ask();
    await until(() => keeper.state().state === 'refused');
    expect(metrics.chatgptStates.at(-1)).toEqual({
      signedIn: false,
      expiresAt: null,
    });
    expect(
      log.of(
        'chatgpt.com refused a fresh ChatGPT token too; mate stays signed out until `chatgpt login`',
      ),
    ).toHaveLength(1);
    await command('chatgpt status');
    expect(said().at(-1)).toMatch(
      /^ℹ️ ChatGPT: signed out, because chatgpt\.com refused a fresh token too, at \d\d:\d\d UTC\. Say `chatgpt login` to sign in again\. .*Now: fallback since \d\d:\d\d UTC \(mate's ChatGPT sign-in stopped working, HTTP 401\), until a sign-in\./,
    );
    // The just-refused rotation can still be clearing its in-flight promise.
    // Once it settles, another check leaves the account signed out.
    await settle();
    expect(await keeper.check()).toBe('refused');
    expect(openai.of('/oauth/token')).toHaveLength(1);

    openai.codex = 'ok';
    await command('chatgpt login');
    expect(keeper.state().state).toBe('good');
    expect(metrics.chatgptStates.at(-1)).toMatchObject({ signedIn: true });
    expect(setup.router?.status().now).toEqual({ route: 'primary' });
    expectNothingSecret();
  });

  test.each<Outcome>([500, 'network'])(
    'a forced rotation that fails with %p is forced again every 15 minutes until one gets through',
    async (outcome) => {
      await signIn(5);
      const ask = () =>
        setup.models.completeSimple(
          setup.model,
          {
            messages: [{ role: 'user', content: 'hi', timestamp: Date.now() }],
          },
          { transport: 'sse' },
        );
      const rotations = () => openai.of('/oauth/token').length;
      openai.codex = 401;
      openai.refresh = outcome;
      await ask();
      await until(() => rotations() === 1);
      await settle();
      expect(setup.router?.status().now).toMatchObject({ reason: 'auth' });
      // A refused token works no longer, so MateChatGPTTokenNotRefreshing counts from here.
      expect(metrics.chatgptStates.at(-1)).toEqual({
        signedIn: true,
        expiresAt: clock.now(),
      });

      await later(RETRY_MS);
      await until(() => rotations() === 2, 2_000);
      await settle();
      expect(setup.router?.status().now).toMatchObject({ reason: 'auth' });

      openai.refresh = 'ok';
      openai.codex = 'ok';
      await later(RETRY_MS);
      await until(() => setup.router?.status().now.route === 'primary');
      expect(rotations()).toBe(3);
      expect(await store.read(CHATGPT_PROVIDER)).toMatchObject({
        refresh: 'rt_SECRET_1',
      });
      expect(metrics.chatgptStates.at(-1)?.expiresAt).toBeGreaterThan(
        clock.now() + 9 * DAY_MS,
      );
      expect((await ask()).provider).toBe(CHATGPT_PROVIDER);

      await later(RETRY_MS);
      await settle();
      expect(rotations()).toBe(3);
      expectNothingSecret();
    },
  );

  test('a forced rotation owed through failures gives way to a new sign-in', async () => {
    await signIn(5);
    openai.refresh = 'network';
    expect(await keeper.forceRefresh()).toBe('transient');
    await signIn(10);
    expect(metrics.chatgptStates.at(-1)).toMatchObject({ signedIn: true });
    expect(metrics.chatgptStates.at(-1)?.expiresAt).toBeGreaterThan(
      clock.now() + 9 * DAY_MS,
    );
    openai.refresh = 'ok';
    await later(RETRY_MS);
    await settle();
    expect(openai.of('/oauth/token')).toHaveLength(1);
  });

  test('a forced refresh rotates a token with days left', async () => {
    await signIn(5);
    expect(await keeper.forceRefresh()).toBe('refreshed');
    expect(openai.of('/oauth/token')).toHaveLength(1);
    expect(await store.read(CHATGPT_PROVIDER)).toMatchObject({
      refresh: 'rt_SECRET_1',
    });
  });

  // pi throws after a forced rotation whose new token lasts no longer than the old.
  test('a forced refresh of a token signed in a moment ago rotates it once and says so', async () => {
    await signIn(10);
    expect(await keeper.forceRefresh()).toBe('refreshed');
    expect(openai.of('/oauth/token')).toHaveLength(1);
    expect(await store.read(CHATGPT_PROVIDER)).toMatchObject({
      refresh: 'rt_SECRET_1',
    });
    expect(log.of('the ChatGPT refresh failed; retrying')).toEqual([]);
    expect(log.of('the ChatGPT token is refreshed')).toHaveLength(1);
    expectNothingSecret();
  });

  test('a forced refresh behind a check that has just rotated does not rotate again', async () => {
    await signIn(1);
    const results = await Promise.all([keeper.check(), keeper.forceRefresh()]);
    expect(results).toEqual(['refreshed', 'refreshed']);
    expect(openai.of('/oauth/token')).toHaveLength(1);
  });

  test('no credential is signed out; an unreadable store reports nothing', async () => {
    up = false;
    expect(await keeper.check()).toBe('store');
    expect(metrics.chatgptStates).toEqual([]);
    up = true;
    expect(await keeper.check()).toBe('none');
    expect(metrics.chatgptStates).toEqual([
      { signedIn: false, expiresAt: null },
    ]);
  });
});

describe('status, logout and pause', () => {
  test('status says what mate holds, which model answers now and why', async () => {
    await keeper.check();
    await command('chatgpt status');
    expect(said()).toEqual([
      expect.stringMatching(
        /^ℹ️ ChatGPT: not signed in\. Say `chatgpt login` to sign in\. Route: openai-codex\/gpt-6-sol \(medium\), fallback opencode-go\/qwen3\.8-max \(medium\)\. Now: fallback since \d\d:\d\d UTC \(mate is not signed in to ChatGPT\), until a sign-in\. Since start: 0 requests on ChatGPT, 0 on the fallback\.$/,
      ),
    ]);
    await signIn(5);
    await command('chatgpt status');
    expect(said().at(-1)).toMatch(
      /^ℹ️ ChatGPT: signed in, token good until \d{4}-\d\d-\d\d \d\d:\d\d UTC\. Route: .*\. Now: primary\. Since start: 0 requests on ChatGPT, 0 on the fallback\.$/,
    );
    await command('chatgpt pause 30');
    await command('chatgpt status');
    expect(said().at(-1)).toMatch(
      /Now: fallback since \d\d:\d\d UTC \(ChatGPT is paused\) until \d\d:\d\d UTC\./,
    );
  });

  test('with turns on OpenCode Go, status says they do not use ChatGPT', async () => {
    wire(FALLBACK, null);
    await keeper.check();
    await command('chatgpt status');
    expect(said()).toEqual([
      `${CHATGPT.status}not signed in. Say \`chatgpt login\` to sign in. Turns use opencode-go/qwen3.8-max (medium), not ChatGPT.`,
    ]);
  });

  test('status stays out of a replay, and an answer that starts with the word ChatGPT does not', async () => {
    await command('chatgpt status');
    expect(said().map(isNotice)).toEqual([true]);
    expect(
      isNotice(
        'ChatGPT: the free tier caps you at 10 messages; Claude has no such cap.',
      ),
    ).toBe(false);
  });

  test('logout forgets the credential, and says how to end the tokens at OpenAI', async () => {
    await signIn(5);
    await keeper.check();
    await command('chatgpt logout');
    expect(said()).toEqual([
      `${CHATGPT.signedOut} and answers with opencode-go/qwen3.8-max. Its last tokens stay valid at OpenAI until they expire; to end them now, sign out of all sessions in ChatGPT's security settings.`,
    ]);
    const rows: unknown[] = await database()
      .sql`SELECT * FROM mate_credentials`;
    expect(rows).toEqual([]);
    expect(keeper.state()).toEqual({ state: 'none' });
    expect(metrics.chatgptStates.at(-1)).toEqual({
      signedIn: false,
      expiresAt: null,
    });
  });

  test('logout cancels a sign-in waiting for its code, quietly', async () => {
    openai.pollGate = new Promise(() => {});
    const waiting = command('chatgpt login');
    await until(() => said().length === 1);
    await command('chatgpt logout');
    await waiting;
    expect(said()).toHaveLength(2);
    expect(said()[1]).toStartWith(CHATGPT.signedOut);
    expect(await store.read(CHATGPT_PROVIDER)).toBeUndefined();
  });

  test('a logout the store refuses says so and keeps the credential', async () => {
    await signIn(5);
    up = false;
    await command('chatgpt logout');
    expect(said()).toEqual([
      `${CHATGPT.logoutFailed}, because its memory is unreachable. Say \`chatgpt logout\` again in a minute.`,
    ]);
    expect(await store.read(CHATGPT_PROVIDER)).toBeDefined();
  });

  test('pause sends every request to the fallback until its time or a resume', async () => {
    await command('chatgpt pause');
    expect(account.paused()).toBe(clock.now() + 60 * 60_000);
    expect(setup.router?.status().now).toMatchObject({ reason: 'paused' });
    expect(said()).toEqual([
      expect.stringMatching(
        /^⏸️ ChatGPT is paused until (?:\d{4}-\d\d-\d\d )?\d\d:\d\d UTC, or until mate restarts, and opencode-go\/qwen3\.8-max answers\. Say `chatgpt resume` to end it sooner\.$/,
      ),
    ]);
    await command('chatgpt resume');
    expect(account.paused()).toBeNull();
    expect(said().at(-1)).toBe(
      `${CHATGPT.resumed}, so the next request tries it.`,
    );

    await command(`chatgpt pause ${PAUSE_MAX_MINUTES}`);
    expect(said().at(-1)).toMatch(/until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    await clock.advance(PAUSE_MAX_MINUTES * 60_000);
    expect(account.paused()).toBeNull();
    expect(metrics.primary).toBe(true);
  });

  test('a resume while signed out says that a sign-in is still needed', async () => {
    await keeper.check();
    await command('chatgpt resume');
    expect(said()).toEqual([
      `${CHATGPT.resumed}, but mate is not signed in to ChatGPT, so opencode-go/qwen3.8-max answers until a sign-in.`,
    ]);
  });

  test.each([
    [
      FALLBACK,
      null,
      'turns use opencode-go/qwen3.8-max, not ChatGPT, so there is nothing to',
    ],
    [
      DEPLOYED,
      null,
      "MATE_FALLBACK_MODEL is none, so nothing answers in ChatGPT's place and there is nothing to",
    ],
  ])(
    'with %s and fallback %p, pause and resume say there is nothing to do',
    async (spec, fallback, why) => {
      wire(spec, fallback);
      await command('chatgpt pause');
      await command('chatgpt resume');
      expect(said()).toEqual([
        `${CHATGPT.status}${why} pause.`,
        `${CHATGPT.status}${why} resume.`,
      ]);
      expect(account.paused()).toBeNull();
    },
  );
});

describe('the egress', () => {
  test("mate's network policy admits every host the sign-in reaches, on 443", async () => {
    await command('chatgpt login');
    await signIn(1);
    await keeper.check();
    expect([...openai.hosts].sort()).toEqual([
      'auth.openai.com',
      'chatgpt.com',
    ]);

    const policy = Bun.YAML.parse(
      await Bun.file(
        new URL(
          '../../../clusters/offsite/apps/mate/network-policy.yaml',
          import.meta.url,
        ),
      ).text(),
    ) as {
      spec: {
        egress: {
          toFQDNs?: { matchName?: string }[];
          toPorts?: { ports: { port: string; protocol: string }[] }[];
        }[];
      };
    };
    const on443 = policy.spec.egress
      .filter((rule) =>
        rule.toPorts?.some((to) =>
          to.ports.some((p) => p.port === '443' && p.protocol === 'TCP'),
        ),
      )
      .flatMap((rule) => rule.toFQDNs ?? [])
      .map((fqdn) => fqdn.matchName);
    for (const host of openai.hosts) expect(on443).toContain(host);
    const fallback = setup.router?.status().fallback?.model;
    for (const model of [setup.model, fallback]) {
      expect(on443).toContain(new URL(model?.baseUrl ?? '').hostname);
    }
  });
});
