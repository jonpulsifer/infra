/**
 * mate's two models behind one `Models`. A request for the primary, ChatGPT,
 * tries it first; when ChatGPT fails before its first content, the same
 * request goes to the fallback inside the same step, so pi never sees the
 * failure. A breaker shared by every thread keeps requests off ChatGPT while
 * it is known down, and one request at a time tries it again, over SSE.
 */
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type AuthResult,
  type Context,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Model,
  type Models,
  type ModelsApiStreamOptions,
  ModelsError,
  type ProviderResponse,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { type Clock, type Handle, utc } from './clock.ts';
import { type Log, plain } from './log.ts';
import type { Instruments } from './metrics.ts';
import {
  LIMIT_FALLBACK,
  PRIMARY_REFUSING,
  SIGN_IN_BROKE,
  SIGNED_OUT,
} from './notices.ts';
import { redact } from './redact.ts';

export const CHATGPT_PROVIDER = 'openai-codex';
/** Codex's first byte takes under a second; its slowest silent reasoning seen took ~45 s. */
export const PRIMARY_TIMEOUT_MS = 120_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const TRANSIENT_MS = MINUTE_MS;
export const STORE_MS = MINUTE_MS;
/** The first wait on a usage limit that names no reset; each one after doubles it. */
export const LIMIT_FIRST_MS = 5 * MINUTE_MS;
export const REJECTED_FIRST_MS = 15 * MINUTE_MS;
export const BACKOFF_MAX_MS = 2 * HOUR_MS;
export const RESET_SLACK_MS = 30_000;
export const RESET_MAX_MS = 7 * 24 * HOUR_MS;
/** Sent over SSE only; the WebSocket path drops it. */
const RESET_HEADER = 'x-codex-primary-reset-after-seconds';
const USED_HEADER = 'x-codex-primary-used-percent';

export type Route = 'primary' | 'fallback';

export type RouteReason =
  | 'limit'
  | 'auth'
  | 'unconfigured'
  | 'transient'
  | 'rejected'
  | 'store'
  | 'paused';

export type Failure = Exclude<RouteReason, 'paused'>;

/**
 * Why a request left ChatGPT, in words that read both after an em dash and
 * before a fallback's error. None matches pi's retry or overflow patterns, so
 * a fallback's error keeps its own retry verdict under the prefix.
 */
export const REASONS: Readonly<Record<RouteReason, string>> = {
  limit: "ChatGPT's usage limit is reached",
  auth: "mate's ChatGPT sign-in stopped working",
  unconfigured: 'mate is not signed in to ChatGPT',
  transient: 'ChatGPT is not answering',
  rejected: 'ChatGPT refused the request',
  store: 'mate cannot read its ChatGPT sign-in',
  paused: 'ChatGPT is paused',
};

/** The fallback's own error behind the router's clause, or null for none. */
export function fallbackError(message: string): string | null {
  for (const words of Object.values(REASONS)) {
    if (!message.startsWith(`${words}; `)) continue;
    const rest = message.slice(words.length + 2);
    const colon = rest.indexOf(': ');
    return colon < 0 ? rest : rest.slice(colon + 2);
  }
  return null;
}

export interface RouteEvent {
  /** pi's `${session}:${lane}`, absent on a request without one. */
  readonly sessionId?: string;
  readonly route: Route;
  /** Why the fallback answers; null on the primary. */
  readonly reason: RouteReason | null;
  /** The model that answers. */
  readonly model: Model<Api>;
}

export interface Fallback {
  readonly model: Model<Api>;
  readonly thinking: ThinkingLevel;
}

export type RouterNow =
  | { readonly route: 'primary' }
  | {
      readonly route: 'fallback';
      readonly reason: RouteReason;
      readonly since: number;
      /** When a request tries ChatGPT again; null waits for a sign-in. */
      readonly retryAt: number | null;
      /** The HTTP status ChatGPT failed with, when it sent one. */
      readonly status: number | null;
    };

export interface RouterStatus {
  readonly primary: Model<Api>;
  readonly fallback: Fallback | null;
  readonly now: RouterNow;
  /** Routed requests since mate started. */
  readonly requests: Readonly<Record<Route, number>>;
}

export interface ModelRouter {
  onRoute(listener: (event: RouteEvent) => void): () => void;
  /**
   * chatgpt.com refused the stored token. `again` is false the first time,
   * when one forced rotation may mend it, and true when it refuses the token
   * that came after, which no rotation mends.
   */
  onTokenRefused(listener: (again: boolean) => void): () => void;
  /** The owner's notice for the outage under way, once for each reason it takes. */
  claimNotice(): string | null;
  /** A sign-in, a rotation or a logout: `stored` is false for a logout. */
  credentialChanged(stored: boolean): void;
  /** OpenAI refused the refresh token, so ChatGPT stays off until a sign-in. */
  authBroken(): void;
  pause(untilMs: number): void;
  /** Ends a pause, and lets the next request try ChatGPT if waiting would. */
  resume(): void;
  status(): RouterStatus;
}

export interface RouteOptions {
  readonly primary: Model<Api>;
  readonly fallback: Fallback | null;
  readonly clock: Clock;
  readonly log: Log;
  readonly metrics?: Pick<Instruments, 'modelRouted' | 'primaryUp'>;
}

interface Outage {
  readonly id: number;
  readonly since: number;
  reason: Failure;
  until: number | null;
  /** The reset came from OpenAI, not from a backoff. */
  resetKnown: boolean;
  status: number | null;
}

type Admission =
  | { readonly kind: 'primary' | 'trial'; readonly generation: number }
  | { readonly kind: 'fallback'; readonly reason: RouteReason };

/** A request sent to ChatGPT, as the breaker admitted it. */
interface Attempt {
  readonly trial: boolean;
  /** The breaker's generation when it was admitted. */
  readonly generation: number;
}

/** What a primary request heard before its first content. */
interface Heard {
  response: ProviderResponse | null;
  model: Model<Api> | null;
}

type Call = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
) => AssistantMessageEventStream;

const LIMIT =
  /usage.?limit|usage_limit_reached|usage_not_included|rate_limit_exceeded|limit.?reached/i;
const UNCONFIGURED = /Provider is not configured|No API key for provider/i;
const AUTH =
  /\b40[13]\b|unauthori[sz]ed|forbidden|invalid.?token|token.{0,12}(?:expired|invalidated|revoked)|authentication token|Failed to extract accountId/i;
const STORE = /Credential store/i;
const TIMED_OUT = /timed? ?out|timeout/i;

const unpricedModels = new WeakMap<Model<Api>, Model<Api>>();

/** ChatGPT at list price would bill a flat-rate plan; its requests cost 0. */
export function unpriced(model: Model<Api>): Model<Api> {
  if (model.provider !== CHATGPT_PROVIDER) return model;
  let free = unpricedModels.get(model);
  if (!free) {
    free = {
      ...model,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    unpricedModels.set(model, free);
  }
  return free;
}

export function spec(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function same(a: Model<Api>, b: Model<Api>): boolean {
  return a.provider === b.provider && a.id === b.id;
}

/**
 * Another model's reasoning is dropped from each assistant message that also
 * holds an answer or a call: pi would replay it as text the model said. A
 * model keeps its own, so Codex keeps its encrypted replay.
 */
export function stripForeignThinking(
  context: Context,
  target: Model<Api>,
): Context {
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== 'assistant') return message;
    if (message.provider === target.provider && message.model === target.id) {
      return message;
    }
    const kept = message.content.filter((block) => block.type !== 'thinking');
    if (kept.length === 0 || kept.length === message.content.length) {
      return message;
    }
    changed = true;
    return { ...message, content: kept };
  });
  return changed ? { ...context, messages } : context;
}

/**
 * A failure before content, by the HTTP status (SSE only) and then the text.
 * A limit's text wins over its status: OpenAI answers a plan without Codex
 * with the usage-limit text and a status of its own.
 */
export function classify(
  message: AssistantMessage,
  status: number | null,
): Failure {
  const text = message.errorMessage ?? '';
  if (status === 429 || LIMIT.test(text)) return 'limit';
  if (status === 401 || status === 403) return 'auth';
  if (status !== null && status >= 500) return 'transient';
  if (status !== null && status >= 400) return 'rejected';
  if (UNCONFIGURED.test(text)) return 'unconfigured';
  if (STORE.test(text)) return 'store';
  if (AUTH.test(text)) return 'auth';
  if (isRetryableAssistantError(message) || TIMED_OUT.test(text)) {
    return 'transient';
  }
  return 'rejected';
}

/** How long until the limit resets, from the SSE header or the error's text. */
export function resetAfterMs(
  message: AssistantMessage,
  response: ProviderResponse | null,
): number | null {
  // Every SSE answer names the weekly window's reset, spent or not.
  const used = Number(response?.headers[USED_HEADER]);
  const header = Number(response?.headers[RESET_HEADER]);
  if (used >= 100 && Number.isFinite(header) && header > 0) {
    return header * 1000;
  }
  const minutes = /Try again in ~(\d+) min/i.exec(message.errorMessage ?? '');
  return minutes?.[1] === undefined ? null : Number(minutes[1]) * MINUTE_MS;
}

export type RefreshFailure =
  | { kind: 'refused'; status: number }
  | { kind: 'transient' | 'store'; why: string };

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

/**
 * pi rejects a refresh with a ModelsError whose cause names the HTTP status.
 * 400, 401 and 403 are a dead refresh token; anything else may pass.
 */
export function refreshFailure(error: unknown): RefreshFailure {
  if (error instanceof ModelsError && error.code === 'auth') {
    return { kind: 'store', why: 'mate-db' };
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const said = `${text(cause)} ${text(error)}`;
  const status = /token refresh failed \((\d{3})\)/.exec(said)?.[1];
  if (status && ['400', '401', '403'].includes(status)) {
    return { kind: 'refused', status: Number(status) };
  }
  if (status) return { kind: 'transient', why: `HTTP ${status}` };
  if (/timed? ?out|abort/i.test(said)) {
    return { kind: 'transient', why: 'timeout' };
  }
  if (/token refresh error/i.test(said)) {
    return { kind: 'transient', why: 'network' };
  }
  return { kind: 'transient', why: 'unexpected' };
}

const NO_USAGE: AssistantMessage['usage'] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failure(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: NO_USAGE,
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now(),
  };
}

function withReasoning(
  options: SimpleStreamOptions | undefined,
  thinking: ThinkingLevel,
): SimpleStreamOptions {
  const { reasoning: _, ...rest } = options ?? {};
  return thinking === 'off' ? rest : { ...rest, reasoning: thinking };
}

function later(next: number | null, current: number | null): boolean {
  if (current === null) return false;
  return next === null || next > current;
}

function backoff(first: number, streak: number): number {
  return Math.min(first * 2 ** streak, BACKOFF_MAX_MS);
}

class Router implements ModelRouter {
  readonly models: Models;
  private readonly routeListeners = new Set<(event: RouteEvent) => void>();
  private readonly refusedListeners = new Set<(again: boolean) => void>();
  private readonly requests: Record<Route, number> = {
    primary: 0,
    fallback: 0,
  };
  private readonly primary: Model<Api>;
  private outage: Outage | null = null;
  private outages = 0;
  /** The reasons whose notice the outage under way has given. */
  private told: { readonly id: number; readonly reasons: Set<Failure> } | null =
    null;
  /**
   * Moves on at each sign-in change and each recovery. A request admitted
   * before one failed on what it replaced, so its failure changes nothing.
   */
  private generation = 0;
  /** The generation of the request trying ChatGPT for the open outage. */
  private trying: number | null = null;
  private limitStreak = 0;
  private rejectedStreak = 0;
  /** The generation that asked for a forced rotation since ChatGPT last answered. */
  private refreshAsked: number | null = null;
  private pausedUntil: number | null = null;
  private pausedAt = 0;
  private pauseTimer: Handle | null = null;

  constructor(
    private readonly inner: Models,
    private readonly options: RouteOptions,
  ) {
    this.primary = unpriced(options.primary);
    this.models = routedModels(inner, (model, context, streamOptions, simple) =>
      this.route(model, context, streamOptions, simple),
    );
    this.report();
  }

  onRoute(listener: (event: RouteEvent) => void): () => void {
    this.routeListeners.add(listener);
    return () => this.routeListeners.delete(listener);
  }

  onTokenRefused(listener: (again: boolean) => void): () => void {
    this.refusedListeners.add(listener);
    return () => this.refusedListeners.delete(listener);
  }

  claimNotice(): string | null {
    const open = this.outage;
    const fallback = this.options.fallback;
    if (!open || !fallback) return null;
    const told =
      this.told?.id === open.id ? this.told.reasons : new Set<Failure>();
    if (told.has(open.reason)) return null;
    const answering = spec(fallback.model);
    const now = this.options.clock.now();
    let notice: string;
    switch (open.reason) {
      case 'limit':
        notice =
          open.resetKnown && open.until !== null
            ? `${LIMIT_FALLBACK} ${answering} until about ${utc(open.until, now)}.`
            : `${LIMIT_FALLBACK} ${answering} and tries ChatGPT again every few minutes.`;
        break;
      case 'unconfigured':
        notice = `${SIGNED_OUT} ${answering}. Say \`chatgpt login\` here to sign it in.`;
        break;
      case 'auth':
        notice = `${SIGN_IN_BROKE} ${answering}. Say \`chatgpt login\` here to sign in again.`;
        break;
      case 'rejected':
        notice = `${PRIMARY_REFUSING} ${answering} for a while. \`chatgpt status\` says why.`;
        break;
      default:
        // A blip or mate-db: the log and the alerts cover them.
        return null;
    }
    told.add(open.reason);
    this.told = { id: open.id, reasons: told };
    return notice;
  }

  credentialChanged(stored: boolean): void {
    this.generation += 1;
    if (!stored) {
      this.fail('unconfigured', null);
      return;
    }
    const open = this.outage;
    if (open && (open.reason === 'auth' || open.reason === 'unconfigured')) {
      this.close('a new ChatGPT sign-in');
    }
  }

  authBroken(): void {
    this.fail('auth', null);
  }

  pause(untilMs: number): void {
    if (!this.options.fallback) return;
    const { clock, log } = this.options;
    this.pausedAt = clock.now();
    this.pausedUntil = untilMs;
    if (this.pauseTimer) clock.cancel(this.pauseTimer);
    this.pauseTimer = clock.after(Math.max(untilMs - this.pausedAt, 0), () => {
      this.pauseTimer = null;
      this.report();
    });
    log.info('ChatGPT is paused', {
      until: new Date(untilMs).toISOString(),
    });
    this.report();
  }

  resume(): void {
    const { clock, log } = this.options;
    if (this.pauseTimer) clock.cancel(this.pauseTimer);
    this.pauseTimer = null;
    if (this.pausedUntil !== null) log.info('ChatGPT is resumed');
    this.pausedUntil = null;
    const open = this.outage;
    if (open?.until != null) open.until = Math.min(open.until, clock.now());
    this.report();
  }

  status(): RouterStatus {
    const now = this.options.clock.now();
    const paused = this.paused(now);
    const open = this.outage;
    return {
      primary: this.primary,
      fallback: this.options.fallback,
      now:
        paused !== null
          ? {
              route: 'fallback',
              reason: 'paused',
              since: this.pausedAt,
              retryAt: paused,
              status: null,
            }
          : open
            ? {
                route: 'fallback',
                reason: open.reason,
                since: open.since,
                retryAt: open.until,
                status: open.status,
              }
            : { route: 'primary' },
      requests: { ...this.requests },
    };
  }

  private paused(now: number): number | null {
    if (this.pausedUntil !== null && this.pausedUntil <= now) {
      this.pausedUntil = null;
    }
    return this.pausedUntil;
  }

  private route(
    requested: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    simple: boolean,
  ): AssistantMessageEventStream {
    const call = direct(this.inner, simple);
    if (!same(requested, this.primary)) {
      return passThrough(call, requested, context, options);
    }
    const out = createAssistantMessageEventStream();
    this.drive(out, call, context, options, simple).catch((error) => {
      this.options.log.error('the model router failed', {
        error: plain(error),
      });
      const message = failure(this.primary, "mate's model router failed");
      out.push({ type: 'error', reason: 'error', error: message });
      out.end(message);
    });
    return out;
  }

  private async drive(
    out: AssistantMessageEventStream,
    call: Call,
    context: Context,
    options: SimpleStreamOptions | undefined,
    simple: boolean,
  ): Promise<void> {
    const fallback = this.options.fallback;
    const admitted = this.admit();
    if (admitted.kind === 'fallback') {
      return this.toFallback(
        out,
        call,
        context,
        options,
        simple,
        admitted.reason,
      );
    }
    const attempt: Attempt = {
      trial: admitted.kind === 'trial',
      generation: admitted.generation,
    };
    const refused = await this.probe();
    if (refused) {
      if (!fallback) return this.forward(out, options, refused);
      this.fail(refused, attempt);
      return this.toFallback(out, call, context, options, simple, refused);
    }
    const heard: Heard = { response: null, model: null };
    const stream = call(
      this.primary,
      stripForeignThinking(context, this.primary),
      {
        ...options,
        ...(fallback ? { timeoutMs: PRIMARY_TIMEOUT_MS } : {}),
        ...(attempt.trial ? { transport: 'sse' } : {}),
        onResponse: (response, model) => {
          heard.response = response;
          heard.model = model;
        },
      },
    );
    let start: AssistantMessageEvent | null = null;
    let committed = false;
    let last: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === 'done') last = event.message;
      if (event.type === 'error') last = event.error;
      if (committed) {
        if (event.type === 'error') {
          this.lateFailure(event.error, heard, attempt);
        }
        out.push(event);
        continue;
      }
      if (event.type === 'start') {
        start = event;
        continue;
      }
      if (event.type === 'error') {
        return this.early(out, call, context, options, simple, event, {
          heard,
          attempt,
        });
      }
      // The first content, or an answer with none: ChatGPT has answered.
      committed = true;
      this.succeed(attempt);
      this.routed(options, 'primary', null, this.primary);
      if (heard.response) {
        await options?.onResponse?.(
          heard.response,
          heard.model ?? this.primary,
        );
      }
      if (start) out.push(start);
      out.push(event);
    }
    out.end(last ?? (await stream.result()));
  }

  /** ChatGPT failed before any content. */
  private async early(
    out: AssistantMessageEventStream,
    call: Call,
    context: Context,
    options: SimpleStreamOptions | undefined,
    simple: boolean,
    event: Extract<AssistantMessageEvent, { type: 'error' }>,
    { heard, attempt }: { heard: Heard; attempt: Attempt },
  ): Promise<void> {
    const fallback = this.options.fallback;
    const message = event.error;
    const aborted =
      message.stopReason === 'aborted' || options?.signal?.aborted === true;
    // Stop and the turn's timeout end the request; pi compacts an overflow.
    if (aborted || isContextOverflow(message, this.primary.contextWindow)) {
      if (!aborted) this.succeed(attempt);
      else this.release(attempt);
      this.routed(options, 'primary', null, this.primary);
      out.push(event);
      out.end(message);
      return;
    }
    const status = heard.response?.status ?? null;
    const reason = classify(message, status);
    this.options.log.warn('ChatGPT failed before answering', {
      reason,
      status,
      // Auth errors can quote the sign-in; the rest say what was refused.
      ...(reason === 'auth' || reason === 'unconfigured'
        ? {}
        : { error: redact(plain(message.errorMessage ?? '')) }),
      fallback: fallback ? spec(fallback.model) : null,
    });
    if (!fallback) {
      return this.forward(out, options, reason, message);
    }
    this.fail(reason, attempt, {
      resetMs:
        reason === 'limit' ? resetAfterMs(message, heard.response) : null,
      status,
      backend: true,
    });
    return this.toFallback(out, call, context, options, simple, reason);
  }

  /** With no fallback, the primary's own failure, less any sign-in text. */
  private forward(
    out: AssistantMessageEventStream,
    options: SimpleStreamOptions | undefined,
    reason: Failure,
    message?: AssistantMessage,
  ): void {
    const said =
      message && reason !== 'auth' && reason !== 'unconfigured'
        ? message
        : {
            ...(message ?? failure(this.primary, '')),
            errorMessage: REASONS[reason],
          };
    this.routed(options, 'primary', null, this.primary);
    out.push({ type: 'error', reason: 'error', error: said });
    out.end(said);
  }

  private async toFallback(
    out: AssistantMessageEventStream,
    call: Call,
    context: Context,
    options: SimpleStreamOptions | undefined,
    simple: boolean,
    reason: RouteReason,
  ): Promise<void> {
    const fallback = this.options.fallback;
    if (!fallback) throw new Error('no fallback to route to');
    const { model, thinking } = fallback;
    this.routed(options, 'fallback', reason, model);
    const stream = call(
      model,
      stripForeignThinking(context, model),
      simple ? withReasoning(options, thinking) : options,
    );
    let last: AssistantMessage | undefined;
    for await (const event of stream) {
      if (event.type === 'error' && event.error.stopReason === 'error') {
        // The fallback's own words, under a fixed clause for ChatGPT's.
        last = {
          ...event.error,
          errorMessage: `${REASONS[reason]}; ${spec(model)}: ${event.error.errorMessage ?? 'the request failed'}`,
        };
        out.push({ ...event, error: last });
        continue;
      }
      if (event.type === 'done') last = event.message;
      if (event.type === 'error') last = event.error;
      out.push(event);
    }
    out.end(last ?? (await stream.result()));
  }

  /** The sign-in, read from memory; a refresh due inside five minutes runs here. */
  private async probe(): Promise<Failure | null> {
    let auth: AuthResult | undefined;
    try {
      auth = await this.inner.getAuth(this.primary.provider);
    } catch (error) {
      const why = refreshFailure(error);
      if (why.kind === 'refused') return 'auth';
      return why.kind;
    }
    return auth ? null : 'unconfigured';
  }

  private admit(): Admission {
    const generation = this.generation;
    if (!this.options.fallback) return { kind: 'primary', generation };
    const now = this.options.clock.now();
    if (this.paused(now) !== null)
      return { kind: 'fallback', reason: 'paused' };
    const open = this.outage;
    if (!open) return { kind: 'primary', generation };
    if (open.until !== null && now >= open.until && this.trying === null) {
      this.trying = generation;
      return { kind: 'trial', generation };
    }
    return { kind: 'fallback', reason: open.reason };
  }

  /** Frees the trial's place; true when `attempt` held it. */
  private release(attempt: Attempt): boolean {
    if (!attempt.trial || this.trying !== attempt.generation) return false;
    this.trying = null;
    return true;
  }

  /** An error after content: pi's retry decides, and the breaker still learns. */
  private lateFailure(
    message: AssistantMessage,
    heard: Heard,
    attempt: Attempt,
  ): void {
    if (message.stopReason === 'aborted') return;
    const reason = classify(message, heard.response?.status ?? null);
    if (reason !== 'limit' && reason !== 'transient') return;
    // Its first content ended any trial it was.
    this.fail(
      reason,
      { trial: false, generation: attempt.generation },
      {
        resetMs:
          reason === 'limit' ? resetAfterMs(message, heard.response) : null,
      },
    );
  }

  /** `attempt` is null for news from outside a request: a refused refresh or a logout. */
  private fail(
    reason: Failure,
    attempt: Attempt | null,
    {
      resetMs = null,
      status = null,
      backend = false,
    }: {
      resetMs?: number | null;
      status?: number | null;
      backend?: boolean;
    } = {},
  ): void {
    const { clock, log, fallback } = this.options;
    // With nothing to fall back to, every request tries ChatGPT anyway.
    if (!fallback) return;
    const trial = attempt !== null && this.release(attempt);
    if (attempt && attempt.generation !== this.generation) return;
    const now = clock.now();
    const open = this.outage;
    // Failures at once share a step of the backoff; a failed trial takes the next.
    const advance = !open || trial || open.reason !== reason;
    const until = this.until(reason, resetMs, now, advance);
    if (!open) {
      this.outages += 1;
      this.outage = {
        id: this.outages,
        since: now,
        reason,
        until,
        resetKnown: resetMs !== null,
        status,
      };
      log.warn('ChatGPT is down; requests go to the fallback', {
        reason,
        retryAt: until === null ? null : new Date(until).toISOString(),
      });
    } else if (
      trial ||
      later(until, open.until) ||
      (until === null && open.until === null)
    ) {
      open.reason = reason;
      open.until = until;
      open.resetKnown = resetMs !== null;
      open.status = status;
    }
    if (reason === 'auth' && backend && attempt) this.tokenRefused(attempt);
    this.report();
  }

  /**
   * One forced rotation per refused token. When chatgpt.com refuses a token
   * issued after the rotation was asked for, the account or the client is
   * refused, not the token, and the keeper hears that instead.
   */
  private tokenRefused(attempt: Attempt): void {
    const asked = this.refreshAsked;
    if (asked !== null && attempt.generation <= asked) return;
    this.refreshAsked = attempt.generation;
    const again = asked !== null;
    for (const listener of this.refusedListeners) {
      this.safely(() => listener(again));
    }
  }

  private until(
    reason: Failure,
    resetMs: number | null,
    now: number,
    advance: boolean,
  ): number | null {
    switch (reason) {
      case 'limit': {
        if (resetMs !== null) {
          return now + Math.min(resetMs + RESET_SLACK_MS, RESET_MAX_MS);
        }
        const streak = advance
          ? this.limitStreak++
          : Math.max(this.limitStreak - 1, 0);
        return now + backoff(LIMIT_FIRST_MS, streak);
      }
      case 'rejected': {
        const streak = advance
          ? this.rejectedStreak++
          : Math.max(this.rejectedStreak - 1, 0);
        return now + backoff(REJECTED_FIRST_MS, streak);
      }
      case 'transient':
        return now + TRANSIENT_MS;
      case 'store':
        return now + STORE_MS;
      case 'auth':
      case 'unconfigured':
        return null;
    }
  }

  /**
   * A request admitted before an outage, a sign-in change or a recovery says
   * nothing about ChatGPT now; a trial does.
   */
  private succeed(attempt: Attempt): void {
    const trial = this.release(attempt);
    if (attempt.generation !== this.generation) return;
    if (this.outage && !trial) return;
    this.limitStreak = 0;
    this.rejectedStreak = 0;
    this.refreshAsked = null;
    if (this.outage) this.close('a trial request');
  }

  private close(by: string): void {
    const open = this.outage;
    if (!open) return;
    this.outage = null;
    this.generation += 1;
    this.options.log.info('ChatGPT answers again', {
      after: open.reason,
      by,
      downMs: this.options.clock.now() - open.since,
    });
    this.report();
  }

  private routed(
    options: SimpleStreamOptions | undefined,
    route: Route,
    reason: RouteReason | null,
    model: Model<Api>,
  ): void {
    this.requests[route] += 1;
    this.options.metrics?.modelRouted(route, reason);
    const event: RouteEvent = {
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      route,
      reason,
      model,
    };
    for (const listener of this.routeListeners) {
      this.safely(() => listener(event));
    }
  }

  private report(): void {
    const up =
      this.outage === null && this.paused(this.options.clock.now()) === null;
    this.options.metrics?.primaryUp(this.options.fallback ? up : null);
  }

  private safely(listener: () => void): void {
    try {
      listener();
    } catch (error) {
      this.options.log.warn('a route listener threw', {
        error: plain(error),
      });
    }
  }
}

type RouteCall = (
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  simple: boolean,
) => AssistantMessageEventStream;

function direct(inner: Models, simple: boolean): Call {
  return simple
    ? (model, context, options) => inner.streamSimple(model, context, options)
    : (model, context, options) =>
        inner.stream(model, context, options as ModelsApiStreamOptions<Api>);
}

/** A request for a model nothing routes, less another model's reasoning. */
function passThrough(
  call: Call,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  return call(unpriced(model), stripForeignThinking(context, model), options);
}

/** `inner` with its four request methods routed and ChatGPT's price at 0. */
function routedModels(inner: Models, route: RouteCall): Models {
  return {
    getProviders: () => inner.getProviders(),
    getProvider: (id) => inner.getProvider(id),
    getModels: (provider) => inner.getModels(provider).map(unpriced),
    getModel: (provider, id) => {
      const model = inner.getModel(provider, id);
      return model && unpriced(model);
    },
    refresh: (options) => inner.refresh(options),
    checkAuth: (id, options) => inner.checkAuth(id, options),
    getAvailable: async (id, options) =>
      (await inner.getAvailable(id, options)).map(unpriced),
    getAuth: ((target: string & Model<Api>, overrides) =>
      inner.getAuth(target, overrides)) as Models['getAuth'],
    login: (id, type, interaction) => inner.login(id, type, interaction),
    logout: (id, options) => inner.logout(id, options),
    stream: (model, context, options) =>
      route(model, context, options as SimpleStreamOptions, false),
    complete: (model, context, options) =>
      route(model, context, options as SimpleStreamOptions, false).result(),
    streamSimple: (model, context, options) =>
      route(model, context, options, true),
    completeSimple: (model, context, options) =>
      route(model, context, options, true).result(),
    streamDeferred: (model, handle, options) =>
      inner.streamDeferred(model, handle, options),
    fetchDeferred: (model, handle, options) =>
      inner.fetchDeferred(model, handle, options),
    cancelDeferred: (model, handle, options) =>
      inner.cancelDeferred(model, handle, options),
  };
}

/**
 * `inner` with nothing routed, for MATE_FALLBACK_MODEL=none: each request
 * goes to the model it names, less another model's reasoning, as a
 * fallback's request would.
 */
export function unroutedModels(inner: Models): Models {
  return routedModels(inner, (model, context, options, simple) =>
    passThrough(direct(inner, simple), model, context, options),
  );
}

/**
 * Wraps `inner`: a request for `primary` goes to ChatGPT first and to
 * `fallback` when ChatGPT cannot answer. Any other model passes straight
 * through, such as a step a run captured before the cutover.
 */
export function routeModels(
  inner: Models,
  options: RouteOptions,
): { models: Models; router: ModelRouter } {
  const router = new Router(inner, options);
  return { models: router.models, router };
}
