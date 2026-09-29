/**
 * The router between ChatGPT and its fallback, over scripted providers that
 * carry mate's provider ids and pi's catalog models: a real AgentHarness
 * first, then each failure class, the breaker, the notices and the pause.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from 'bun:test';
import {
  AgentHarness,
  type AgentHarnessTool,
  type AgentMessage,
  BACKGROUND_CONTEXT,
  MemorySessionRepo,
  type ThinkingLevel,
} from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthOperationOptions,
  type Context,
  type Credential,
  calculateCost,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  InMemoryCredentialStore,
  isContextOverflow,
  isRetryableAssistantError,
  type JsonValue,
  type Model,
  type Models,
  type OAuthCredential,
  type SimpleStreamOptions,
  type TranscriptContext,
  Type,
} from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go';
import {
  LIMIT_FALLBACK,
  PRIMARY_REFUSING,
  SIGN_IN_BROKE,
  SIGNED_OUT,
} from '../src/notices.ts';
import { SECRET_SHAPED } from '../src/redact.ts';
import {
  BACKOFF_MAX_MS,
  CHATGPT_PROVIDER,
  classify,
  fallbackError,
  LIMIT_FIRST_MS,
  type ModelRouter,
  PRIMARY_TIMEOUT_MS,
  REASONS,
  REJECTED_FIRST_MS,
  RESET_SLACK_MS,
  type RouteEvent,
  resetAfterMs,
  routeModels,
  STORE_MS,
  stripForeignThinking,
  TRANSIENT_MS,
  unroutedModels,
} from '../src/route.ts';
import {
  FakeClock,
  NOON_UTC,
  RecordingInstruments,
  RecordingLog,
  settle,
} from './support.ts';

const ctx = BACKGROUND_CONTEXT;
const MINUTE_MS = 60_000;
const SESSION = 'session-1:main';

function catalog(models: readonly Model<Api>[], id: string): Model<Api> {
  const model = models.find((one) => one.id === id);
  if (!model) throw new Error(`pi lists no ${id}`);
  return model;
}

const SOL = catalog(openaiCodexProvider().getModels(), 'gpt-6-sol');
const QWEN = catalog(opencodeGoProvider().getModels(), 'qwen3.8-max');

interface Call {
  readonly model: string;
  readonly transport?: string;
  readonly timeoutMs?: number;
  readonly reasoning?: string;
  readonly hasReasoning: boolean;
  readonly sessionId?: string;
  readonly messages: TranscriptContext['messages'];
}

type Play =
  | {
      readonly text: string;
      readonly thinking?: string;
      readonly status?: number;
      readonly headers?: Record<string, string>;
    }
  | {
      readonly call: string;
      readonly args: Record<string, JsonValue>;
      readonly id: string;
    }
  | {
      readonly fail: string;
      readonly status?: number;
      readonly headers?: Record<string, string>;
      /** WebSocket's `response.created` before a `response.failed`. */
      readonly started?: boolean;
    }
  | { readonly failAfter: string; readonly text: string }
  /** Holds until the request is aborted or the gate opens. */
  | { readonly hold: Promise<Play> };

/** A provider that plays a script, as pi's providers stream. */
class Scripted {
  readonly calls: Call[] = [];
  readonly provider;
  private readonly plays: Play[] = [];

  constructor(id: string, models: readonly Model<Api>[], auth: ProviderAuth) {
    this.provider = createProvider({
      id,
      auth,
      models,
      api: {
        stream: (model, context, options) =>
          this.stream(model, context, options),
        streamSimple: (model, context, options) =>
          this.stream(model, context, options),
      },
    });
  }

  script(...plays: Play[]): void {
    this.plays.push(...plays);
  }

  private stream(
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
  ): AssistantMessageEventStream {
    this.calls.push({
      model: model.id,
      transport: options?.transport,
      timeoutMs: options?.timeoutMs,
      reasoning: options?.reasoning,
      hasReasoning: options !== undefined && 'reasoning' in options,
      sessionId: options?.sessionId,
      messages: context.messages,
    });
    const out = createAssistantMessageEventStream();
    void this.play(out, model, options, this.plays.shift());
    return out;
  }

  private async play(
    out: AssistantMessageEventStream,
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
    play: Play | undefined,
  ): Promise<void> {
    const usage = {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2000,
    };
    const message: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        ...usage,
        cost: calculateCost(model, { ...usage, cost: NO_COST }),
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const fail = (errorMessage: string, reason: 'error' | 'aborted') => {
      const failed = { ...message, stopReason: reason, errorMessage };
      out.push({ type: 'error', reason, error: failed });
      out.end(failed);
    };
    await Promise.resolve();
    if (!play) return fail('no play scripted', 'error');
    if ('hold' in play) {
      const aborted = new Promise<null>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(null)),
      );
      const next = await Promise.race([play.hold, aborted]);
      if (next === null) return fail('Request was aborted', 'aborted');
      return this.play(out, model, options, next);
    }
    if (
      ('status' in play && play.status) ||
      ('headers' in play && play.headers)
    ) {
      await options?.onResponse?.(
        {
          status: ('status' in play && play.status) || 200,
          headers: ('headers' in play && play.headers) || {},
        },
        model,
      );
    }
    if ('fail' in play) {
      if (play.started) out.push({ type: 'start', partial: message });
      return fail(play.fail, 'error');
    }
    out.push({ type: 'start', partial: message });
    if ('call' in play) {
      const toolCall = {
        type: 'toolCall' as const,
        id: play.id,
        name: play.call,
        arguments: play.args,
      };
      message.content.push(toolCall);
      out.push({ type: 'toolcall_start', contentIndex: 0, partial: message });
      out.push({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall,
        partial: message,
      });
      message.stopReason = 'toolUse';
      out.push({ type: 'done', reason: 'toolUse', message });
      out.end(message);
      return;
    }
    let index = 0;
    if ('thinking' in play && play.thinking) {
      message.content.push({ type: 'thinking', thinking: play.thinking });
      out.push({
        type: 'thinking_start',
        contentIndex: index,
        partial: message,
      });
      out.push({
        type: 'thinking_end',
        contentIndex: index,
        content: play.thinking,
        partial: message,
      });
      index += 1;
    }
    message.content.push({ type: 'text', text: play.text });
    out.push({ type: 'text_start', contentIndex: index, partial: message });
    out.push({
      type: 'text_delta',
      contentIndex: index,
      delta: play.text,
      partial: message,
    });
    if ('failAfter' in play) return fail(play.failAfter, 'error');
    out.push({
      type: 'text_end',
      contentIndex: index,
      content: play.text,
      partial: message,
    });
    out.push({ type: 'done', reason: 'stop', message });
    out.end(message);
  }
}

type ProviderAuth = Parameters<typeof createProvider>[0]['auth'];

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** mate-db, as far as pi can tell: it counts ChatGPT's reads, and can go down. */
class Store extends InMemoryCredentialStore {
  reads = 0;
  down = false;

  override read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId === CHATGPT_PROVIDER) this.reads += 1;
    if (this.down) return Promise.reject(new Error('mate-db is down'));
    return super.read(providerId, options);
  }
}

interface Rig {
  readonly models: Models;
  readonly router: ModelRouter;
  readonly codex: Scripted;
  readonly go: Scripted;
  readonly store: Store;
  readonly clock: FakeClock;
  readonly log: RecordingLog;
  readonly metrics: RecordingInstruments;
  readonly events: RouteEvent[];
  /** When the router asked for a forced rotation. */
  readonly refused: number[];
  /** When chatgpt.com refused the token a rotation or a sign-in gave. */
  readonly stuck: number[];
  /** pi's own Models under the router. */
  readonly inner: ReturnType<typeof createModels>;
  /** What the next refresh answers: a new token, or a failure with a status. */
  refresh: 'ok' | number;
  signIn(expiresInMs?: number): Promise<void>;
}

beforeEach(() => setSystemTime(new Date(NOON_UTC)));
afterEach(() => setSystemTime());

function rig(
  options: { fallback?: boolean; fallbackThinking?: ThinkingLevel } = {},
): Rig {
  const store = new Store();
  const clock = new FakeClock(Date.now());
  const log = new RecordingLog();
  const metrics = new RecordingInstruments();
  const partial: { refresh: 'ok' | number } = { refresh: 'ok' };
  const oauth = {
    name: 'ChatGPT',
    login: () => Promise.reject(new Error('no sign-in in these tests')),
    refresh: async (credential: OAuthCredential) => {
      if (partial.refresh !== 'ok') {
        throw new Error(
          `OpenAI Codex token refresh failed (${partial.refresh}): {"refresh_token":"rt_SECRET"}`,
        );
      }
      return { ...credential, expires: Date.now() + 10 * 86_400_000 };
    },
    toAuth: async (credential: OAuthCredential) => ({
      apiKey: credential.access,
    }),
  };
  const codex = new Scripted(CHATGPT_PROVIDER, [SOL], { oauth });
  const go = new Scripted('opencode-go', [QWEN], {
    apiKey: {
      name: 'OpenCode Go',
      resolve: async () => ({ auth: { apiKey: 'go-key' } }),
    },
  });
  const inner = createModels({ credentials: store });
  inner.setProvider(codex.provider);
  inner.setProvider(go.provider);
  const { models, router } = routeModels(inner, {
    primary: SOL,
    fallback:
      options.fallback === false
        ? null
        : { model: QWEN, thinking: options.fallbackThinking ?? 'medium' },
    clock,
    log,
    metrics,
  });
  const events: RouteEvent[] = [];
  router.onRoute((event) => events.push(event));
  const refused: number[] = [];
  const stuck: number[] = [];
  router.onTokenRefused((again) => (again ? stuck : refused).push(clock.now()));
  const built = {
    models,
    router,
    codex,
    go,
    store,
    clock,
    log,
    metrics,
    events,
    refused,
    stuck,
    inner,
    signIn: async (expiresInMs = 5 * 86_400_000) => {
      await store.modify(CHATGPT_PROVIDER, async () => ({
        type: 'oauth',
        access: 'access-token',
        refresh: 'rt_SECRET',
        expires: Date.now() + expiresInMs,
      }));
      router.credentialChanged(true);
    },
  };
  return Object.defineProperty(built, 'refresh', {
    get: () => partial.refresh,
    set: (value: 'ok' | number) => {
      partial.refresh = value;
    },
  }) as Rig;
}

async function signedIn(options?: Parameters<typeof rig>[0]): Promise<Rig> {
  const made = rig(options);
  await made.signIn();
  return made;
}

const HELLO: Context = {
  systemPrompt: 'You help.',
  messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
};

function ask(
  made: Rig,
  options: SimpleStreamOptions = {},
  context: Context = HELLO,
): Promise<AssistantMessage> {
  return made.models.completeSimple(SOL, context, {
    sessionId: SESSION,
    reasoning: 'high',
    timeoutMs: 240_000,
    ...options,
  });
}

async function collect(
  stream: AssistantMessageEventStream,
): Promise<AssistantMessageEvent[]> {
  const seen: AssistantMessageEvent[] = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

/** Plays that each wait for their own answer, in the order requests take them. */
function gates(count: number): {
  plays: Play[];
  answer: ((play: Play) => void)[];
} {
  const answer: ((play: Play) => void)[] = [];
  const plays = Array.from(
    { length: count },
    (): Play => ({
      hold: new Promise<Play>((resolve) => answer.push(resolve)),
    }),
  );
  return { plays, answer };
}

function waitMs(made: Rig): number | null {
  const now = made.router.status().now;
  return now.route === 'fallback' && now.retryAt !== null
    ? now.retryAt - made.clock.now()
    : null;
}

const LIMIT_SSE =
  'You have hit your ChatGPT usage limit (prolite plan). Try again in ~30 min.';
const LIMIT_WS = 'Codex error: The usage limit has been reached';

const echo: AgentHarnessTool<undefined> = {
  name: 'echo',
  label: 'echo',
  description: 'Says its text back.',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: (params as { text: string }).text }],
    details: undefined,
  }),
};

function said(message: AgentMessage): string {
  if (!('role' in message)) return 'custom';
  if (message.role !== 'assistant') return message.role;
  return `${message.provider}/${message.model}:${message.stopReason}`;
}

describe('the harness', () => {
  // The research left open whether AgentHarness takes a wrapped Models; this settles it.
  test('runs a tool turn over the routed Models, and the step ChatGPT cannot answer goes to qwen3.8-max inside it', async () => {
    const made = await signedIn({ fallbackThinking: 'low' });
    made.codex.script(
      { call: 'echo', args: { text: 'hi' }, id: 'call_1' },
      { fail: LIMIT_WS, started: true },
    );
    made.go.script({ text: 'echo said hi' });
    const session = await new MemorySessionRepo().create(
      { id: 'session-1' },
      ctx,
    );
    const { harness } = await AgentHarness.create<undefined>(
      {
        session,
        models: made.models,
        model: SOL,
        thinkingLevel: 'high',
        tools: [echo],
        systemPrompt: 'You help.',
        streamOptions: { timeoutMs: 240_000 },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      },
      ctx,
    );
    try {
      const lane = await harness.lane('main', ctx);
      const run = await lane.prompt('say hi through echo', undefined, ctx);
      expect(run.ok && 'status' in run.value && run.value.status).toBe(
        'completed',
      );
      const entries = await lane.findEntries(
        { type: 'message', order: 'newestFirst', limit: 10 },
        ctx,
      );
      const messages = entries
        .flatMap((entry) => (entry.type === 'message' ? [entry.message] : []))
        .reverse();
      expect(messages.map(said)).toEqual([
        'user',
        'openai-codex/gpt-6-sol:toolUse',
        'toolResult',
        'opencode-go/qwen3.8-max:stop',
      ]);
      // The lane keeps its level; the fallback gets its own.
      expect(made.codex.calls.map((call) => call.reasoning)).toEqual([
        'high',
        'high',
      ]);
      expect(made.go.calls.map((call) => call.reasoning)).toEqual(['low']);
      expect(made.go.calls[0]?.messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'toolResult',
      ]);
      expect(made.events.map((e) => [e.route, e.reason, e.sessionId])).toEqual([
        ['primary', null, 'session-1:main'],
        ['fallback', 'limit', 'session-1:main'],
      ]);
    } finally {
      await harness.close(ctx);
    }
  });
});

describe('a request for the primary', () => {
  test('goes to ChatGPT with its own timeout and the transport asked for, at no cost', async () => {
    const made = await signedIn();
    made.codex.script({ text: 'hi' });
    const events = await collect(
      made.models.streamSimple(SOL, HELLO, {
        sessionId: SESSION,
        timeoutMs: 240_000,
      }),
    );
    expect(events.filter((e) => e.type === 'start')).toHaveLength(1);
    const answer = events.at(-1);
    expect(answer?.type === 'done' && answer.message.usage.cost.total).toBe(0);
    expect(made.codex.calls).toEqual([
      expect.objectContaining({
        timeoutMs: PRIMARY_TIMEOUT_MS,
        transport: undefined,
        sessionId: SESSION,
      }),
    ]);
    expect(made.go.calls).toEqual([]);
    expect(made.metrics.routes).toEqual([{ route: 'primary', reason: null }]);
    expect(made.metrics.primary).toBe(true);
    expect(made.router.status().requests).toEqual({ primary: 1, fallback: 0 });
  });

  test('another model passes straight through, as a step saved before the cutover resumes', async () => {
    const made = await signedIn();
    made.go.script({ text: 'still qwen' });
    const answer = await made.models.completeSimple(QWEN, HELLO, {
      reasoning: 'high',
    });
    expect(answer.provider).toBe('opencode-go');
    expect(answer.usage.cost.total).toBeGreaterThan(0);
    expect(made.go.calls[0]?.reasoning).toBe('high');
    expect(made.codex.calls).toEqual([]);
    expect(made.events).toEqual([]);
    expect(made.metrics.routes).toEqual([]);
  });

  test("ChatGPT's list price is zeroed; the fallback keeps its shadow", async () => {
    const made = await signedIn();
    expect(made.models.getModel(CHATGPT_PROVIDER, 'gpt-6-sol')?.cost).toEqual(
      NO_COST_RATES,
    );
    expect(made.models.getModels(CHATGPT_PROVIDER)[0]?.cost).toEqual(
      NO_COST_RATES,
    );
    expect(made.models.getModel('opencode-go', 'qwen3.8-max')?.cost).toEqual(
      QWEN.cost,
    );
    made.codex.script({ fail: 'upstream connect error', status: 503 });
    made.go.script({ text: 'from qwen' });
    expect((await ask(made)).usage.cost.total).toBeCloseTo(0.008, 6);
  });

  test('the caller hears the response of the model that answers, not one ChatGPT refused', async () => {
    const made = await signedIn();
    made.codex.script(
      { fail: LIMIT_SSE, status: 429 },
      { text: 'back', status: 200 },
    );
    made.go.script({ text: 'qwen', status: 200 });
    const heard: string[] = [];
    const onResponse = (response: { status: number }, model: Model<Api>) => {
      heard.push(`${model.provider} ${response.status}`);
    };
    await ask(made, { onResponse });
    expect(heard).toEqual(['opencode-go 200']);
    await made.clock.advance(31 * MINUTE_MS);
    await ask(made, { onResponse });
    expect(heard).toEqual(['opencode-go 200', 'openai-codex 200']);
  });

  test('`stream` and `complete` are routed too', async () => {
    const made = await signedIn();
    made.codex.script({ fail: LIMIT_SSE, status: 429 });
    made.go.script({ text: 'from qwen' });
    const answer = await made.models.complete(SOL, HELLO, {});
    expect(answer.provider).toBe('opencode-go');
    expect(made.go.calls[0]?.hasReasoning).toBe(false);
  });
});

describe('a failure before any content', () => {
  test('a usage limit over SSE falls back, and ChatGPT is left alone until its reset', async () => {
    const made = await signedIn();
    made.codex.script({
      fail: LIMIT_SSE,
      status: 429,
      headers: {
        'x-codex-primary-reset-after-seconds': '1800',
        'x-codex-primary-used-percent': '100',
      },
    });
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' });
    expect((await ask(made)).provider).toBe('opencode-go');
    const retryAt = made.clock.now() + 30 * MINUTE_MS + RESET_SLACK_MS;
    expect(made.router.status().now).toEqual({
      route: 'fallback',
      reason: 'limit',
      since: made.clock.now(),
      retryAt,
      status: 429,
    });
    expect(made.metrics.primary).toBe(false);
    await made.clock.advance(30 * MINUTE_MS);
    expect((await ask(made)).provider).toBe('opencode-go');
    expect(made.codex.calls).toHaveLength(1);
    expect(made.metrics.routes).toEqual([
      { route: 'fallback', reason: 'limit' },
      { route: 'fallback', reason: 'limit' },
    ]);
  });

  test("the reset comes from the text's `~N min` when no header says it", async () => {
    const made = await signedIn();
    made.codex.script({ fail: LIMIT_SSE, status: 429 });
    made.go.script({ text: 'qwen' });
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      retryAt: made.clock.now() + 30 * MINUTE_MS + RESET_SLACK_MS,
    });
  });

  test('a limit inside a 200 waits the backoff, not the weekly reset every SSE answer names', async () => {
    const made = await signedIn();
    made.codex.script({
      fail: 'rate_limit_exceeded: Rate limit reached, please slow down',
      status: 200,
      headers: {
        'x-codex-primary-reset-after-seconds': '518400',
        'x-codex-primary-used-percent': '3',
      },
    });
    made.go.script({ text: 'qwen' });
    await ask(made, { transport: 'sse' });
    expect(made.router.status().now).toMatchObject({ reason: 'limit' });
    expect(waitMs(made)).toBe(LIMIT_FIRST_MS);
  });

  test('one trial over SSE after the reset: its answer closes the breaker, and the next request is ordinary', async () => {
    const made = await signedIn();
    made.codex.script(
      { fail: LIMIT_SSE, status: 429 },
      { text: 'back' },
      { text: 'again' },
    );
    made.go.script({ text: 'qwen' });
    await ask(made);
    await made.clock.advance(30 * MINUTE_MS + RESET_SLACK_MS);
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect(made.metrics.primary).toBe(true);
    await ask(made);
    expect(made.codex.calls.map((call) => call.transport)).toEqual([
      undefined,
      'sse',
      undefined,
    ]);
    expect(made.log.of('ChatGPT answers again')).toHaveLength(1);
  });

  test('only one request tries ChatGPT at a time; the rest keep the fallback', async () => {
    const made = await signedIn();
    let answer = (_play: Play) => {};
    made.codex.script(
      { fail: 'server_error', status: 500 },
      {
        hold: new Promise<Play>((resolve) => {
          answer = resolve;
        }),
      },
    );
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' });
    await ask(made);
    await made.clock.advance(TRANSIENT_MS);
    const trial = ask(made);
    await settle();
    expect((await ask(made)).provider).toBe('opencode-go');
    answer({ text: 'back' });
    expect((await trial).provider).toBe(CHATGPT_PROVIDER);
    expect(made.codex.calls).toHaveLength(2);
  });

  test('a WebSocket limit with no reset backs off 5 minutes, then 10', async () => {
    const made = await signedIn();
    made.codex.script(
      { fail: LIMIT_WS, started: true },
      { fail: LIMIT_WS, started: true },
    );
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' });
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      reason: 'limit',
      retryAt: made.clock.now() + LIMIT_FIRST_MS,
    });
    await made.clock.advance(LIMIT_FIRST_MS);
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      reason: 'limit',
      retryAt: made.clock.now() + 2 * LIMIT_FIRST_MS,
    });
  });

  test.each<[string, Play, number]>([
    ['a WebSocket limit', { fail: LIMIT_WS, started: true }, LIMIT_FIRST_MS],
    [
      'a refusal',
      { fail: 'model is not supported', status: 400 },
      REJECTED_FIRST_MS,
    ],
  ])(
    '%s that fails three requests at once waits the first backoff, and a failed trial doubles it',
    async (_, play, first) => {
      const made = await signedIn();
      const { plays, answer } = gates(3);
      made.codex.script(...plays, play);
      made.go.script(
        { text: '1' },
        { text: '2' },
        { text: '3' },
        { text: '4' },
      );
      const asked = ['a', 'b', 'c'].map((id) =>
        ask(made, { sessionId: `${id}:main` }),
      );
      await settle();
      for (const open of answer) open(play);
      await Promise.all(asked);
      expect(waitMs(made)).toBe(first);
      await made.clock.advance(first);
      await ask(made);
      expect(made.codex.calls).toHaveLength(4);
      expect(waitMs(made)).toBe(2 * first);
    },
  );

  test('start, then an error: the fallback answers, and the consumer sees one start', async () => {
    const made = await signedIn();
    made.codex.script({ fail: LIMIT_WS, started: true });
    made.go.script({ text: 'from qwen' });
    const events = await collect(
      made.models.streamSimple(SOL, HELLO, { sessionId: SESSION }),
    );
    const starts = events.filter((e) => e.type === 'start');
    expect(starts).toHaveLength(1);
    expect(starts[0]?.type === 'start' && starts[0].partial.provider).toBe(
      'opencode-go',
    );
    expect(events.at(-1)?.type).toBe('done');
  });

  test('no sign-in: the fallback answers, and ChatGPT is not asked again until one', async () => {
    const made = rig();
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' }, { text: 'qwen 3' });
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      reason: 'unconfigured',
      retryAt: null,
    });
    const reads = made.store.reads;
    await made.clock.advance(7 * 86_400_000);
    await ask(made);
    expect(made.store.reads).toBe(reads);
    expect(made.codex.calls).toEqual([]);
    made.codex.script({ text: 'signed in' });
    await made.signIn();
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
  });

  test('a refresh OpenAI refuses keeps ChatGPT off until a sign-in, with no trial', async () => {
    const made = rig();
    await made.signIn(MINUTE_MS);
    made.refresh = 401;
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' });
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      reason: 'auth',
      retryAt: null,
    });
    await made.clock.advance(7 * 86_400_000);
    await ask(made);
    expect(made.codex.calls).toEqual([]);
    // Only chatgpt.com's refusal asks for a rotation; this was the rotation.
    expect(made.refused).toEqual([]);
    expect(JSON.stringify(made.log.entries)).not.toContain('SECRET');
  });

  test('a refresh that times out or fails upstream is a blip', async () => {
    const made = rig();
    await made.signIn(MINUTE_MS);
    made.refresh = 503;
    made.go.script({ text: 'qwen' });
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      reason: 'transient',
      retryAt: made.clock.now() + TRANSIENT_MS,
    });
  });

  test('mate-db down is a minute on the fallback, with no notice', async () => {
    const made = await signedIn();
    made.store.down = true;
    made.go.script({ text: 'qwen' });
    await ask(made);
    expect(made.router.status().now).toMatchObject({
      reason: 'store',
      retryAt: made.clock.now() + STORE_MS,
    });
    expect(made.router.claimNotice()).toBeNull();
  });

  test.each<[string, Play]>([
    ['a 5xx', { fail: 'upstream connect error', status: 503 }],
    ['a closed socket', { fail: 'WebSocket closed 1006', started: true }],
    ['a timeout', { fail: 'Request timed out after 120000ms' }],
  ])(
    '%s falls back at once and leaves ChatGPT alone for a minute',
    async (_, play) => {
      const made = await signedIn();
      made.codex.script(play);
      made.go.script({ text: 'qwen' });
      expect((await ask(made)).provider).toBe('opencode-go');
      expect(made.router.status().now).toMatchObject({
        reason: 'transient',
        retryAt: made.clock.now() + TRANSIENT_MS,
      });
      expect(made.router.claimNotice()).toBeNull();
    },
  );

  test('a refused request backs off 15 minutes, doubling to two hours, and says why once', async () => {
    const made = await signedIn();
    const rejected = { fail: 'model is not supported', status: 400 };
    made.codex.script(rejected, rejected, rejected, rejected, rejected);
    made.go.script(
      { text: '1' },
      { text: '2' },
      { text: '3' },
      { text: '4' },
      { text: '5' },
    );
    const waits: (number | null)[] = [];
    for (let i = 0; i < 5; i += 1) {
      await ask(made);
      const now = made.router.status().now;
      const retryAt = now.route === 'fallback' ? now.retryAt : null;
      waits.push(retryAt === null ? null : retryAt - made.clock.now());
      if (retryAt !== null)
        await made.clock.advance(retryAt - made.clock.now());
    }
    expect(waits).toEqual([
      REJECTED_FIRST_MS,
      2 * REJECTED_FIRST_MS,
      4 * REJECTED_FIRST_MS,
      BACKOFF_MAX_MS,
      BACKOFF_MAX_MS,
    ]);
    expect(made.router.claimNotice()).toBe(
      `${PRIMARY_REFUSING} opencode-go/qwen3.8-max for a while. \`chatgpt status\` says why.`,
    );
    expect(made.router.claimNotice()).toBeNull();
    expect(made.log.of('ChatGPT failed before answering')[0]?.fields).toEqual(
      expect.objectContaining({ reason: 'rejected', status: 400 }),
    );
  });

  test('chatgpt.com refusing the token asks for one rotation until ChatGPT answers again', async () => {
    const made = await signedIn();
    const refused = {
      fail: 'Provided authentication token is expired',
      status: 401,
    };
    made.codex.script(refused, refused, { text: 'back' }, refused);
    made.go.script({ text: '1' }, { text: '2' }, { text: '3' });
    await ask(made);
    expect(made.refused).toHaveLength(1);
    // The rotation writes a new token.
    await made.signIn();
    await ask(made);
    expect(made.refused).toHaveLength(1);
    await made.signIn();
    await ask(made);
    await ask(made);
    expect(made.refused).toHaveLength(2);
  });

  test('two requests refused on one token ask for one rotation', async () => {
    const made = await signedIn();
    const { plays, answer } = gates(2);
    made.codex.script(...plays);
    made.go.script({ text: 'a' }, { text: 'b' });
    const refused: Play = { fail: 'Unauthorized', status: 401 };
    const a = ask(made, { sessionId: 'a:main' });
    const b = ask(made, { sessionId: 'b:main' });
    await settle();
    answer[0]?.(refused);
    answer[1]?.(refused);
    await Promise.all([a, b]);
    expect(made.refused).toHaveLength(1);
    expect(made.stuck).toEqual([]);
  });

  test('chatgpt.com refusing the token its rotation gave says the sign-in is stuck, once', async () => {
    const made = await signedIn();
    const refused: Play = { fail: 'Unauthorized', status: 401 };
    made.codex.script(refused, refused);
    made.go.script({ text: '1' }, { text: '2' }, { text: '3' });
    await ask(made);
    expect(made.refused).toHaveLength(1);
    expect(made.stuck).toEqual([]);
    // The rotation writes a new token.
    await made.signIn();
    await ask(made);
    expect(made.refused).toHaveLength(1);
    expect(made.stuck).toHaveLength(1);
    expect(made.router.status().now).toMatchObject({
      reason: 'auth',
      retryAt: null,
    });
    await ask(made);
    expect(made.codex.calls).toHaveLength(2);
    expect(made.stuck).toHaveLength(1);
  });

  test('Stop is forwarded as it is: no fallback, and no verdict on ChatGPT', async () => {
    const made = await signedIn();
    made.codex.script({ hold: new Promise<Play>(() => {}) });
    const stop = new AbortController();
    const asked = ask(made, { signal: stop.signal });
    await settle();
    stop.abort();
    const answer = await asked;
    expect(answer.stopReason).toBe('aborted');
    expect(made.go.calls).toEqual([]);
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect(made.metrics.failures).toEqual([]);
  });

  test('a Stop during the trial lets the next request try instead', async () => {
    const made = await signedIn();
    made.codex.script(
      { fail: 'server_error', status: 500 },
      { hold: new Promise<Play>(() => {}) },
      { text: 'back' },
    );
    made.go.script({ text: 'qwen' });
    await ask(made);
    await made.clock.advance(TRANSIENT_MS);
    const stop = new AbortController();
    const trial = ask(made, { signal: stop.signal });
    await settle();
    stop.abort();
    expect((await trial).stopReason).toBe('aborted');
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
  });

  test('a trial the router throws on still lets the next request try', async () => {
    const made = await signedIn();
    made.codex.script(
      { fail: 'server_error', status: 500 },
      { fail: 'server_error', status: 500 },
      { text: 'back' },
    );
    made.go.script({ text: 'qwen' });
    await ask(made);
    await made.clock.advance(TRANSIENT_MS);
    spyOn(made.metrics, 'primaryFailed').mockImplementationOnce(() => {
      throw new Error('a meter that throws');
    });
    expect((await ask(made)).errorMessage).toBe("mate's model router failed");
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
    expect(made.codex.calls.map((call) => call.transport)).toEqual([
      undefined,
      'sse',
      'sse',
    ]);
  });

  test("a failed trial still answering on the fallback leaves the next trial's place alone", async () => {
    const made = await signedIn();
    const next = gates(1);
    const answering = gates(1);
    made.codex.script(
      { fail: 'server_error', status: 500 },
      { fail: 'server_error', status: 500 },
      ...next.plays,
    );
    made.go.script({ text: 'qwen 1' }, ...answering.plays, {
      text: 'qwen 3',
    });
    await ask(made);
    await made.clock.advance(TRANSIENT_MS);
    const failed = ask(made, { sessionId: 'a:main' });
    await settle();
    await made.clock.advance(TRANSIENT_MS);
    const trial = ask(made, { sessionId: 'b:main' });
    await settle();
    answering.answer[0]?.({ text: 'qwen 2' });
    expect((await failed).provider).toBe('opencode-go');
    await settle();
    expect((await ask(made)).provider).toBe('opencode-go');
    expect(made.codex.calls).toHaveLength(3);
    next.answer[0]?.({ text: 'back' });
    expect((await trial).provider).toBe(CHATGPT_PROVIDER);
  });

  test('an overflow is forwarded, so pi compacts instead of falling back', async () => {
    const made = await signedIn();
    made.codex.script({
      fail: 'Your input exceeds the context window of this model',
      status: 400,
    });
    const answer = await ask(made);
    expect(answer.errorMessage).toContain('exceeds the context window');
    expect(made.go.calls).toEqual([]);
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect(made.metrics.failures).toEqual([]);
  });
});

describe('a failure after content', () => {
  test('is forwarded for pi to retry, and still teaches the breaker', async () => {
    const made = await signedIn();
    made.codex.script({ text: 'half an', failAfter: 'WebSocket closed 1006' });
    made.go.script({ text: 'qwen' });
    const answer = await ask(made);
    expect(answer.provider).toBe(CHATGPT_PROVIDER);
    expect(answer.errorMessage).toBe('WebSocket closed 1006');
    expect(made.go.calls).toEqual([]);
    expect(made.router.status().now).toMatchObject({ reason: 'transient' });
    expect((await ask(made)).provider).toBe('opencode-go');
  });

  test('a request that answers after an outage began says nothing about it', async () => {
    const made = await signedIn();
    let answer = (_play: Play) => {};
    made.codex.script(
      {
        hold: new Promise<Play>((resolve) => {
          answer = resolve;
        }),
      },
      { fail: LIMIT_SSE, status: 429 },
    );
    made.go.script({ text: 'qwen' });
    const early = ask(made);
    await settle();
    await ask(made);
    answer({ text: 'late' });
    expect((await early).provider).toBe(CHATGPT_PROVIDER);
    expect(made.router.status().now).toMatchObject({ reason: 'limit' });
  });
});

describe('a request admitted before the breaker changed', () => {
  test('its refusal of a token a rotation has replaced opens nothing, so the new token is used', async () => {
    const made = await signedIn();
    const { plays, answer } = gates(2);
    made.codex.script(...plays, { text: 'the new token works' });
    made.go.script({ text: 'qwen a' }, { text: 'qwen b' });
    const refused: Play = { fail: 'Unauthorized', status: 401 };
    const a = ask(made, { sessionId: 'a:main' });
    const b = ask(made, { sessionId: 'b:main' });
    await settle();
    answer[0]?.(refused);
    expect((await a).provider).toBe('opencode-go');
    expect(made.refused).toHaveLength(1);
    // The keeper's rotation writes a new token.
    await made.signIn();
    expect(made.router.status().now).toEqual({ route: 'primary' });
    answer[1]?.(refused);
    expect((await b).provider).toBe('opencode-go');
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect(made.refused).toHaveLength(1);
    expect(made.stuck).toEqual([]);
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
    expect(made.router.claimNotice()).toBeNull();
  });

  test("its refusal of a token the keeper's scheduled rotation replaced opens nothing", async () => {
    const made = await signedIn();
    const { plays, answer } = gates(1);
    made.codex.script(...plays, { text: 'the new token works' });
    made.go.script({ text: 'qwen' });
    const asked = ask(made);
    await settle();
    await made.signIn();
    answer[0]?.({ fail: 'Unauthorized', status: 401 });
    expect((await asked).provider).toBe('opencode-go');
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect(made.refused).toEqual([]);
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
  });

  test('its refusal after a logout leaves the outage a logout', async () => {
    const made = await signedIn();
    const { plays, answer } = gates(1);
    made.codex.script(...plays);
    made.go.script({ text: 'qwen' });
    const asked = ask(made);
    await settle();
    made.router.credentialChanged(false);
    answer[0]?.({ fail: 'Unauthorized', status: 401 });
    await asked;
    expect(made.router.status().now).toMatchObject({
      reason: 'unconfigured',
    });
    expect(made.refused).toEqual([]);
    expect(made.router.claimNotice()).toStartWith(SIGNED_OUT);
  });

  test('its answer on a token a rotation replaced says nothing of the new one', async () => {
    const made = await signedIn();
    const { plays, answer } = gates(1);
    const refused: Play = { fail: 'Unauthorized', status: 401 };
    made.codex.script(...plays, refused, refused);
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' });
    const old = ask(made, { sessionId: 'old:main' });
    await settle();
    await ask(made);
    await made.signIn();
    answer[0]?.({ text: 'on the old token' });
    expect((await old).provider).toBe(CHATGPT_PROVIDER);
    await ask(made);
    expect(made.refused).toHaveLength(1);
    expect(made.stuck).toHaveLength(1);
  });

  test('a trial a rotation overtook still lets the next request try', async () => {
    const made = await signedIn();
    const { plays, answer } = gates(1);
    made.codex.script({ fail: LIMIT_WS, started: true }, ...plays, {
      text: 'back',
    });
    made.go.script({ text: 'qwen 1' }, { text: 'qwen 2' });
    await ask(made);
    await made.clock.advance(LIMIT_FIRST_MS);
    const trial = ask(made);
    await settle();
    await made.signIn();
    answer[0]?.({ fail: LIMIT_WS, started: true });
    expect((await trial).provider).toBe('opencode-go');
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
    expect(made.router.status().now).toEqual({ route: 'primary' });
  });

  test('its failure after a trial closed the outage opens no new one', async () => {
    const made = await signedIn();
    const { plays, answer } = gates(2);
    made.codex.script(...plays, { text: 'back' }, { text: 'again' });
    made.go.script({ text: 'qwen a' }, { text: 'qwen b' });
    const dropped: Play = { fail: 'WebSocket closed 1006', started: true };
    const a = ask(made, { sessionId: 'a:main' });
    const b = ask(made, { sessionId: 'b:main' });
    await settle();
    answer[0]?.(dropped);
    expect((await a).provider).toBe('opencode-go');
    await made.clock.advance(TRANSIENT_MS);
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
    answer[1]?.(dropped);
    expect((await b).provider).toBe('opencode-go');
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
  });
});

describe('the failure count', () => {
  // MateModelPrimaryFailing reads it, so a blip in a busy minute is one.
  test('one blip counts one ChatGPT failure, however many requests the breaker then sends past it', async () => {
    const made = await signedIn();
    made.codex.script({ fail: 'WebSocket closed 1006', started: true });
    made.go.script(
      ...Array.from({ length: 6 }, (_, i): Play => ({ text: `qwen ${i}` })),
    );
    for (let i = 0; i < 6; i += 1) {
      await ask(made);
      await made.clock.advance(8_000);
    }
    expect(made.codex.calls).toHaveLength(1);
    expect(
      made.metrics.routes.filter((one) => one.route === 'fallback'),
    ).toHaveLength(6);
    expect(made.metrics.failures).toEqual(['transient']);
  });

  test('counts each request ChatGPT fails, after content, on a trial and at the sign-in, and nothing else', async () => {
    const made = await signedIn();
    made.codex.script(
      { text: 'half an', failAfter: 'WebSocket closed 1006' },
      { fail: 'model is not supported', status: 400 },
    );
    made.go.script({ text: '1' }, { text: '2' }, { text: '3' });
    await ask(made);
    expect(made.metrics.failures).toEqual(['transient']);
    await made.clock.advance(TRANSIENT_MS);
    await ask(made);
    expect(made.metrics.failures).toEqual(['transient', 'rejected']);
    made.store.down = true;
    await made.clock.advance(REJECTED_FIRST_MS);
    await ask(made);
    expect(made.metrics.failures).toEqual(['transient', 'rejected', 'store']);
    made.router.authBroken();
    made.router.credentialChanged(false);
    made.router.pause(made.clock.now() + MINUTE_MS);
    expect(made.metrics.failures).toHaveLength(3);
  });
});

describe('when the fallback fails too', () => {
  test('its error follows a fixed clause, never ChatGPT’s own words, and keeps its retry verdict', async () => {
    const made = await signedIn();
    made.codex.script({
      fail: 'unauthorized: token sk-abcdefghijklmnopqrstuvwxyz0123456789 is dead',
      status: 401,
    });
    made.go.script({ fail: '503 service unavailable', status: 503 });
    const answer = await ask(made);
    expect(answer.errorMessage).toBe(
      "mate's ChatGPT sign-in stopped working; opencode-go/qwen3.8-max: 503 service unavailable",
    );
    expect(answer.errorMessage?.match(SECRET_SHAPED)).toBeNull();
    expect(JSON.stringify(made.log.entries)).not.toContain('sk-');
    expect(isRetryableAssistantError(answer)).toBe(true);
    expect(fallbackError(answer.errorMessage ?? '')).toBe(
      '503 service unavailable',
    );

    made.go.script({ fail: 'GoUsageLimitError: Monthly usage limit reached' });
    const spent = await ask(made);
    expect(isRetryableAssistantError(spent)).toBe(false);
  });

  // pi retries, compacts or gives up by the error's words, so no clause may sway it.
  test.each(Object.entries(REASONS))(
    "the %s clause leaves pi's verdict on the fallback's error as it was",
    (_reason, clause) => {
      const as = (errorMessage: string): AssistantMessage => ({
        role: 'assistant',
        content: [],
        api: QWEN.api,
        provider: QWEN.provider,
        model: QWEN.id,
        usage: { ...ZERO_USAGE },
        stopReason: 'error',
        errorMessage,
        timestamp: 0,
      });
      for (const own of [
        'model is not supported',
        '503 service unavailable',
        'Range of input length should be [1, 1000000]',
      ]) {
        const routed = as(`${clause}; opencode-go/qwen3.8-max: ${own}`);
        expect(isRetryableAssistantError(routed)).toBe(
          isRetryableAssistantError(as(own)),
        );
        expect(isContextOverflow(routed, QWEN.contextWindow)).toBe(
          isContextOverflow(as(own), QWEN.contextWindow),
        );
        expect(fallbackError(routed.errorMessage ?? '')).toBe(own);
      }
    },
  );
});

describe('with no fallback', () => {
  test("ChatGPT's own failure is forwarded, less any sign-in words, and nothing opens", async () => {
    const made = rig({ fallback: false });
    const answer = await ask(made);
    expect(answer.errorMessage).toBe('mate is not signed in to ChatGPT');
    await made.signIn();
    made.codex.script(
      { fail: LIMIT_SSE, status: 429 },
      { fail: 'unauthorized: {"refresh_token":"rt_SECRET"}', status: 401 },
      { text: 'hi' },
    );
    expect((await ask(made)).errorMessage).toBe(LIMIT_SSE);
    expect((await ask(made)).errorMessage).toBe(
      "mate's ChatGPT sign-in stopped working",
    );
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
    expect(made.router.status().now).toEqual({ route: 'primary' });
    expect(made.router.claimNotice()).toBeNull();
    expect(made.metrics.primary).toBeNull();
  });
});

describe('the notice', () => {
  test('is claimed once per outage, and a new outage says it again', async () => {
    const made = await signedIn();
    made.codex.script(
      { fail: LIMIT_SSE, status: 429 },
      { text: 'back' },
      { fail: LIMIT_WS, started: true },
    );
    made.go.script({ text: '1' }, { text: '2' });
    await ask(made);
    expect(made.router.claimNotice()).toMatch(
      new RegExp(
        `^${LIMIT_FALLBACK} opencode-go/qwen3\\.8-max until about \\d\\d:\\d\\d UTC\\.$`,
      ),
    );
    expect(made.router.claimNotice()).toBeNull();
    await made.clock.advance(31 * MINUTE_MS);
    await ask(made);
    expect(made.router.claimNotice()).toBeNull();
    await ask(made);
    expect(made.router.claimNotice()).toBe(
      `${LIMIT_FALLBACK} opencode-go/qwen3.8-max and tries ChatGPT again every few minutes.`,
    );
  });

  test('an outage that turns into one with its own notice says the new one', async () => {
    const made = await signedIn();
    made.codex.script({ fail: LIMIT_SSE, status: 429 });
    made.go.script({ text: '1' }, { text: '2' });
    await ask(made);
    expect(made.router.claimNotice()).toStartWith(LIMIT_FALLBACK);
    made.router.authBroken();
    await ask(made);
    expect(made.router.claimNotice()).toBe(
      `${SIGN_IN_BROKE} opencode-go/qwen3.8-max. Say \`chatgpt login\` here to sign in again.`,
    );
    expect(made.router.claimNotice()).toBeNull();
  });

  test('names a missing sign-in, and a sign-in OpenAI stopped honouring', async () => {
    const made = rig();
    made.go.script({ text: '1' });
    await ask(made);
    expect(made.router.claimNotice()).toBe(
      `${SIGNED_OUT} opencode-go/qwen3.8-max. Say \`chatgpt login\` here to sign it in.`,
    );
    await made.signIn();
    made.router.authBroken();
    expect(made.router.claimNotice()).toBe(
      `${SIGN_IN_BROKE} opencode-go/qwen3.8-max. Say \`chatgpt login\` here to sign in again.`,
    );
  });

  test('a logout sends every request to the fallback until a sign-in', async () => {
    const made = await signedIn();
    made.router.credentialChanged(false);
    made.go.script({ text: 'qwen' });
    expect((await ask(made)).provider).toBe('opencode-go');
    expect(made.events.at(-1)).toMatchObject({ reason: 'unconfigured' });
  });
});

describe('a pause', () => {
  test('sends every request to the fallback without asking ChatGPT, and says nothing', async () => {
    const made = await signedIn();
    made.router.pause(made.clock.now() + 30 * MINUTE_MS);
    expect(made.metrics.primary).toBe(false);
    made.go.script({ text: 'paused' });
    const reads = made.store.reads;
    expect((await ask(made)).provider).toBe('opencode-go');
    expect(made.store.reads).toBe(reads);
    expect(made.events.at(-1)).toMatchObject({
      route: 'fallback',
      reason: 'paused',
    });
    expect(made.router.claimNotice()).toBeNull();
    await made.clock.advance(30 * MINUTE_MS);
    expect(made.metrics.primary).toBe(true);
    made.codex.script({ text: 'back' });
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
  });

  test('a resume ends it, and lets the next request try a timed outage at once', async () => {
    const made = await signedIn();
    made.codex.script({ fail: LIMIT_SSE, status: 429 }, { text: 'back' });
    made.go.script({ text: 'qwen' });
    await ask(made);
    made.router.pause(made.clock.now() + 60 * MINUTE_MS);
    made.router.resume();
    expect(made.router.status().now).toMatchObject({
      reason: 'limit',
      retryAt: made.clock.now(),
    });
    expect((await ask(made)).provider).toBe(CHATGPT_PROVIDER);
  });
});

describe('classify', () => {
  const failed = (errorMessage: string): AssistantMessage => ({
    role: 'assistant',
    content: [],
    api: SOL.api,
    provider: SOL.provider,
    model: SOL.id,
    usage: { ...ZERO_USAGE },
    stopReason: 'error',
    errorMessage,
    timestamp: 0,
  });

  test.each<[string, number | null, string]>([
    [LIMIT_SSE, 429, 'limit'],
    [LIMIT_WS, null, 'limit'],
    ['usage_not_included', 403, 'limit'],
    ['Try again in ~500 min.', 429, 'limit'],
    ['whatever', 401, 'auth'],
    ['whatever', 403, 'auth'],
    ['Codex error: Provided authentication token is expired', null, 'auth'],
    ['Failed to extract accountId from token', null, 'auth'],
    ['Codex error: Could not parse your authentication token', null, 'auth'],
    ['Provider is not configured: openai-codex', null, 'unconfigured'],
    ['Credential store read failed for openai-codex', null, 'store'],
    ['bad gateway', 502, 'transient'],
    ['fetch failed', null, 'transient'],
    ['WebSocket closed 1006', null, 'transient'],
    ['Codex SSE response headers timed out after 120000ms', null, 'transient'],
    ['Unsupported parameter', 400, 'rejected'],
    ['Codex error: Instructions are not valid', null, 'rejected'],
  ])('%p with status %p is %s', (text, status, reason) => {
    expect(classify(failed(text), status)).toBe(reason as never);
  });

  test('the reset is the SSE header once the weekly window is spent, or the minutes in the text', () => {
    const spent = {
      'x-codex-primary-reset-after-seconds': '90',
      'x-codex-primary-used-percent': '100',
    };
    expect(
      resetAfterMs(failed(LIMIT_SSE), { status: 429, headers: spent }),
    ).toBe(90_000);
    // Every SSE answer names the weekly reset, spent or not.
    for (const headers of [
      { ...spent, 'x-codex-primary-used-percent': '99' },
      { 'x-codex-primary-reset-after-seconds': '90' },
    ]) {
      expect(resetAfterMs(failed(LIMIT_SSE), { status: 429, headers })).toBe(
        30 * MINUTE_MS,
      );
      expect(
        resetAfterMs(failed(LIMIT_WS), { status: 200, headers }),
      ).toBeNull();
    }
    expect(resetAfterMs(failed(LIMIT_SSE), null)).toBe(30 * MINUTE_MS);
    expect(resetAfterMs(failed(LIMIT_WS), null)).toBeNull();
  });
});

describe('stripForeignThinking', () => {
  const assistant = (
    provider: string,
    model: string,
    content: AssistantMessage['content'],
  ): AssistantMessage => ({
    role: 'assistant',
    content,
    api: 'x',
    provider,
    model,
    usage: { ...ZERO_USAGE },
    stopReason: 'stop',
    timestamp: 0,
  });
  const thought = {
    type: 'thinking' as const,
    thinking: 'hmm',
    thinkingSignature: 'enc',
  };
  const answer = { type: 'text' as const, text: 'hi' };

  test("drops another model's reasoning beside an answer, and keeps a model's own", () => {
    const codex = assistant(CHATGPT_PROVIDER, 'gpt-6-sol', [thought, answer]);
    const qwen = assistant('opencode-go', 'qwen3.8-max', [thought, answer]);
    const alone = assistant('opencode-go', 'qwen3.8-max', [thought]);
    const context: Context = { messages: [codex, qwen, alone] };

    const toQwen = stripForeignThinking(context, QWEN).messages;
    expect(toQwen[0]).toEqual({ ...codex, content: [answer] });
    expect(toQwen[1]).toBe(qwen);
    expect(toQwen[2]).toBe(alone);

    const toCodex = stripForeignThinking(context, SOL).messages;
    expect(toCodex[0]).toBe(codex);
    expect(toCodex[1]).toEqual({ ...qwen, content: [answer] });
    expect(stripForeignThinking(HELLO, SOL)).toBe(HELLO);
  });

  test('each leg of a fallback is handed only reasoning its own model wrote', async () => {
    const made = await signedIn();
    made.codex.script({ fail: 'server_error', status: 500 });
    made.go.script({ text: 'qwen' });
    const history: Context = {
      messages: [
        { role: 'user', content: 'one', timestamp: 0 },
        assistant(CHATGPT_PROVIDER, 'gpt-6-sol', [thought, answer]),
        { role: 'user', content: 'two', timestamp: 0 },
      ],
    };
    await ask(made, {}, history);
    const blocks = (call: Call | undefined) =>
      call?.messages.flatMap((m) =>
        m.role === 'assistant' ? m.content.map((b) => b.type) : [],
      );
    expect(blocks(made.codex.calls[0])).toEqual(['thinking', 'text']);
    expect(blocks(made.go.calls[0])).toEqual(['text']);
  });

  test('a step a run captured on another model, and the rollback with no router, drop it too', async () => {
    const made = await signedIn();
    made.go.script({ text: 'resumed' }, { text: 'rolled back' });
    const history: Context = {
      messages: [
        { role: 'user', content: 'one', timestamp: 0 },
        assistant(CHATGPT_PROVIDER, 'gpt-6-sol', [thought, answer]),
        { role: 'user', content: 'two', timestamp: 0 },
      ],
    };
    await made.models.completeSimple(QWEN, history, {});
    // MATE_MODEL=opencode-go/qwen3.8-max with MATE_FALLBACK_MODEL=none.
    const rollback = unroutedModels(made.inner);
    await rollback.completeSimple(QWEN, history, {});
    const blocks = made.go.calls.map((call) =>
      call.messages.flatMap((m) =>
        m.role === 'assistant' ? m.content.map((b) => b.type) : [],
      ),
    );
    expect(blocks).toEqual([['text'], ['text']]);
    expect(rollback.getModel(CHATGPT_PROVIDER, 'gpt-6-sol')?.cost).toEqual(
      NO_COST_RATES,
    );
  });
});

describe('the fallback level', () => {
  test("'off' sends no reasoning at all", async () => {
    const made = await signedIn({ fallbackThinking: 'off' });
    made.codex.script({ fail: 'server_error', status: 500 });
    made.go.script({ text: 'qwen' });
    await ask(made);
    expect(made.codex.calls[0]?.reasoning).toBe('high');
    expect(made.go.calls[0]?.hasReasoning).toBe(false);
  });
});

const NO_COST_RATES = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ZERO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: NO_COST,
};
