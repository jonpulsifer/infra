/**
 * `/api/ai`: an OpenAI-compatible passthrough that adds the operator's key and
 * meters a per-site daily budget. Only allow-listed paths are forwarded, and
 * headers are rebuilt in both directions.
 */
import { createHash } from 'node:crypto';
import { bodyOf } from './documents.ts';
import { isJson, logCause, ok, refuse } from './http.ts';
import { secondsToMidnight } from './limits.ts';
import type { Ctx } from './sites.ts';

/** A prompt is text; a body near this size is not one. */
export const MAX_AI_BODY_BYTES = 256 * 1024;
/** The per-site UTC day, whichever runs out first. */
export const MAX_AI_REQUESTS_DAY = 200;
export const MAX_AI_TOKENS_DAY = 500_000;
/** Under Cloudflare's 100 s origin timeout, for the first byte and each gap. */
export const AI_FIRST_BYTE_MS = 90_000;
export const AI_GAP_MS = 90_000;
/** Bun's idle timeout for these routes; a model can think past the default. */
export const AI_IDLE_SECONDS = 120;
/** Concurrency, which is the cost ceiling a daily budget cannot express. */
export const MAX_AI_IN_FLIGHT_SITE = 4;
export const MAX_AI_IN_FLIGHT_ADDRESS = 2;
/** How much of an answer's tail is kept to read `usage` from. */
const MAX_SCAN_BYTES = 1024 * 1024;
/**
 * Anything else is a 404 before the budget is touched. Image and audio
 * endpoints report no `usage`, and neither upstream base has `/embeddings`.
 */
const UPSTREAM = {
  '/chat/completions': 'POST',
  '/models': 'GET',
} as const;

type UpstreamPath = keyof typeof UPSTREAM;

/** As the `ai_usage` primary key spells the day. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function aiUsage(
  ctx: Ctx,
  name: string,
  day = utcDay(),
): Promise<{ requests: number; tokens: number }> {
  const [row] = (await ctx.sql`
    select requests, tokens from ai_usage
    where site = ${name} and day = ${day} limit 1
  `) as { requests: number; tokens: string | number }[];
  return {
    requests: Number(row?.requests ?? 0),
    tokens: Number(row?.tokens ?? 0),
  };
}

/**
 * One statement, so concurrent calls cannot both take the last request, kept in
 * Postgres so a restart does not reset it. No row returns once the day is spent.
 */
async function spendRequest(
  ctx: Ctx,
  name: string,
  day: string,
): Promise<boolean> {
  const spent = (await ctx.sql`
    insert into ai_usage (site, day, requests, tokens)
    values (${name}, ${day}, 1, 0)
    on conflict (site, day) do update
      set requests = ai_usage.requests + 1
      where ai_usage.requests < ${MAX_AI_REQUESTS_DAY}
        and ai_usage.tokens < ${MAX_AI_TOKENS_DAY}
    returning requests
  `) as { requests: number }[];
  return spent.length > 0;
}

/** Logged, never raised: the response has already been sent. */
function bill(ctx: Ctx, name: string, day: string, tokens: number): void {
  if (tokens <= 0) return;
  void ctx.sql`
    update ai_usage set tokens = tokens + ${tokens}
    where site = ${name} and day = ${day}
  `.catch((cause: unknown) => logCause(ctx.id, 'billing ai tokens', cause));
}

/**
 * Only for deployment faults: a body the upstream refuses keeps its charge, or
 * it could loop for free. `greatest` keeps the unlocked row from going negative.
 */
function refundRequest(ctx: Ctx, name: string, day: string): void {
  void ctx.sql`
    update ai_usage set requests = greatest(requests - 1, 0)
    where site = ${name} and day = ${day}
  `.catch((cause: unknown) =>
    logCause(ctx.id, 'refunding an ai request', cause),
  );
}

// ponytail: in-process counters, sound while the server runs one replica;
// Postgres advisory locks when there is a second.
const inFlight = new Map<string, number>();

/** `null` when any counter is full. Call the result to give the slots back. */
export function enter(
  keys: readonly (readonly [string, number])[],
): (() => void) | null {
  if (keys.some(([key, limit]) => (inFlight.get(key) ?? 0) >= limit)) {
    return null;
  }
  for (const [key] of keys) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    for (const [key] of keys) {
      const held = (inFlight.get(key) ?? 1) - 1;
      if (held <= 0) inFlight.delete(key);
      else inFlight.set(key, held);
    }
  };
}

interface Prepared {
  /** Rewritten, so not the bytes the client sent. */
  readonly body: string;
  /** Billed when the answer states no `usage`, such as an aborted stream. */
  readonly fallbackTokens: number;
}

/** Without `include_usage` a streamed completion reports no usage. */
function prepare(
  ctx: Ctx,
  parsed: unknown,
  maxTokens: number,
): Prepared | 'MALFORMED_REQUEST' | 'INVALID_MODEL' {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'MALFORMED_REQUEST';
  }
  const body = parsed as Record<string, unknown>;

  const named = typeof body.model === 'string' ? body.model.trim() : '';
  const model = named === '' ? ctx.config.aiModel : named;
  if (ctx.config.aiModels.length > 0 && !ctx.config.aiModels.includes(model)) {
    return 'INVALID_MODEL';
  }
  const out: Record<string, unknown> = { ...body, model };

  // `n` multiplies the bill by a number the budget sees only after spending it.
  if (body.n !== undefined && Number(body.n) !== 1) return 'MALFORMED_REQUEST';

  // Both spellings are clamped, so a body carrying both cannot pass the ceiling.
  let ceiling = 0;
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    if (body[key] === undefined) continue;
    const asked = Number(body[key]);
    const clamped =
      Number.isFinite(asked) && asked > 0
        ? Math.min(asked, maxTokens)
        : maxTokens;
    out[key] = clamped;
    ceiling = Math.max(ceiling, clamped);
  }
  // Neither was sent, so the ceiling is stated to the upstream.
  if (ceiling === 0) {
    out.max_tokens = maxTokens;
    ceiling = maxTokens;
  }

  if (body.stream === true) {
    const options =
      typeof body.stream_options === 'object' && body.stream_options !== null
        ? (body.stream_options as Record<string, unknown>)
        : {};
    out.stream_options = { ...options, include_usage: true };
  }
  // The larger of the two, so sending both cannot lower the billing floor.
  return { body: JSON.stringify(out), fallbackTokens: ceiling };
}

/**
 * A stream carries `usage` in its last `data:` frame, a single response at the
 * top level. A single response over {@link MAX_SCAN_BYTES} falls back.
 */
export function tokensIn(text: string): number | null {
  let last: number | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const total = totalOf(trimmed.slice(5).trim());
    if (total !== null) last = total;
  }
  return last ?? totalOf(text);
}

function totalOf(raw: string): number | null {
  if (raw === '' || raw === '[DONE]') return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  const total = (body as { usage?: { total_tokens?: unknown } } | null)?.usage
    ?.total_tokens;
  return typeof total === 'number' && Number.isFinite(total) ? total : null;
}

/**
 * A leading `v1` is optional on upstream paths, because `/api/ai/v1` is the
 * OpenAI base URL. `/api/ai/usage` takes no `v1`.
 */
export async function aiApi(
  request: Request,
  ctx: Ctx,
  name: string,
  segments: readonly string[],
  address: string | null,
): Promise<Response> {
  const tail = segments.slice(3);
  // `usage` is this server's own number and spends nothing.
  if (tail.length === 1 && tail[0] === 'usage') {
    if (request.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', ctx.id);
    return today(ctx, name);
  }
  if (tail[0] === 'v1') tail.shift();
  const path = `/${tail.join('/')}`;

  if (!Object.hasOwn(UPSTREAM, path)) return refuse('NOT_FOUND', ctx.id);
  const route = path as UpstreamPath;
  if (request.method !== UPSTREAM[route]) {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  // Answered locally: a `no-cors` GET has no `Origin`, so a relayed one would
  // let any page spend a site's day with `<img src=…/models>`.
  if (route === '/models') return models(ctx);

  let sent: Prepared = { body: '', fallbackTokens: 0 };
  if (UPSTREAM[route] === 'POST') {
    if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
    const body = await bodyOf(request, MAX_AI_BODY_BYTES);
    if ('code' in body) return refuse(body.code, ctx.id);
    // Anonymous on every site, so this route gets the public ceiling.
    const prepared = prepare(ctx, body.json, ctx.config.aiMaxTokens);
    if (typeof prepared === 'string') return refuse(prepared, ctx.id);
    sent = prepared;
  }

  const keys: [string, number][] = [[`site:${name}`, MAX_AI_IN_FLIGHT_SITE]];
  if (address !== null) {
    keys.push([`address:${address}`, MAX_AI_IN_FLIGHT_ADDRESS]);
  }
  const slot = enter(keys);
  if (slot === null) {
    return refuse('RATE_LIMITED', ctx.id, { 'retry-after': '5' });
  }

  const day = utcDay();
  let allowed: boolean;
  try {
    allowed = await spendRequest(ctx, name, day);
  } catch (cause) {
    slot();
    logCause(ctx.id, 'reading the ai budget', cause);
    return refuse('STORAGE_FAILURE', ctx.id);
  }
  if (!allowed) {
    slot();
    return refuse('AI_BUDGET', ctx.id, {
      'retry-after': String(secondsToMidnight()),
    });
  }

  try {
    return await forward(request, ctx, name, day, route, sent, slot);
  } catch (cause) {
    slot();
    logCause(ctx.id, `the ai upstream at ${route}`, cause);
    return refuse('AI_UPSTREAM', ctx.id);
  }
}

/** This server's own list, unmetered: a model outside it is a 400 anyway. */
function models(ctx: Ctx): Response {
  const ids =
    ctx.config.aiModels.length > 0 ? ctx.config.aiModels : [ctx.config.aiModel];
  return ok(
    {
      object: 'list',
      data: ids.map((id) => ({ id, object: 'model', owned_by: 'kthx' })),
    },
    ctx.id,
  );
}

async function today(ctx: Ctx, name: string): Promise<Response> {
  const day = utcDay();
  const spent = await aiUsage(ctx, name, day);
  return ok(
    {
      day,
      requests: spent.requests,
      tokens: spent.tokens,
      quotas: {
        requests_day: MAX_AI_REQUESTS_DAY,
        tokens_day: MAX_AI_TOKENS_DAY,
      },
    },
    ctx.id,
  );
}

/**
 * OpenCode's Go base answers `400 MissingSessionID` without this. Derived from
 * the site name, never the request, and hashed because it appears in their logs.
 */
function sessionOf(name: string): string {
  return `kthx-${createHash('sha256').update(name).digest('hex').slice(0, 32)}`;
}

/** Every way the call ends runs through `settle`, so the day is charged once. */
async function forward(
  request: Request,
  ctx: Ctx,
  name: string,
  day: string,
  path: UpstreamPath,
  sent: Prepared,
  slot: () => void,
): Promise<Response> {
  const key = ctx.config.aiKey;
  if (key === null) {
    slot();
    // Refunded, like every deployment fault.
    refundRequest(ctx, name, day);
    logCause(ctx.id, 'the ai upstream', new Error('KTHX_AI_KEY is not set'));
    return refuse('AI_UPSTREAM', ctx.id);
  }

  // Built from scratch, so the client's `Authorization`, cookies,
  // `x-forwarded-*` and query string never reach the upstream.
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    'user-agent': 'kthx',
    'x-opencode-session': sessionOf(name),
  });
  const accept = request.headers.get('accept');
  if (accept !== null) headers.set('accept', accept);
  const post = UPSTREAM[path] === 'POST';
  if (post) headers.set('content-type', 'application/json');

  const upstream = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const settle = (tokens: number): void => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    request.signal.removeEventListener('abort', cut);
    slot();
    bill(ctx, name, day, tokens);
  };
  const cut = (): void => {
    upstream.abort();
    settle(sent.fallbackTokens);
  };
  request.signal.addEventListener('abort', cut, { once: true });
  deadline = setTimeout(cut, AI_FIRST_BYTE_MS);

  let answer: Response;
  try {
    answer = await fetch(`${ctx.config.aiUrl}${path}`, {
      method: UPSTREAM[path],
      headers,
      body: post ? sent.body : undefined,
      signal: upstream.signal,
    });
  } catch (cause) {
    // An unreachable upstream is a deployment fault, like a 503: no tokens,
    // and the request refunded.
    settle(0);
    refundRequest(ctx, name, day);
    logCause(ctx.id, `the ai upstream at ${path}`, cause);
    return refuse('AI_UPSTREAM', ctx.id);
  }
  clearTimeout(deadline);

  // 401, 403 and 5xx are deployment faults: `AI_UPSTREAM`, and the request is
  // refunded. Any other 4xx is about the caller's body and stays charged.
  const ours =
    answer.status === 401 || answer.status === 403 || answer.status >= 500;

  // Logged, or an upstream refusal would show only in a page's console.
  if (!answer.ok) {
    logCause(
      ctx.id,
      `the ai upstream at ${path} refused`,
      new Error(`upstream ${answer.status}`),
    );
  }

  if (ours) {
    void answer.body?.cancel();
    settle(0);
    refundRequest(ctx, name, day);
    return refuse('AI_UPSTREAM', ctx.id);
  }

  const out = new Headers({
    'content-type': answer.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': ctx.id,
  });
  // An upstream refusal is relayed with its status but bills no tokens.
  const fallback = answer.ok ? sent.fallbackTokens : 0;
  if (answer.body === null) {
    settle(fallback);
    return new Response(null, { status: answer.status, headers: out });
  }

  const decoder = new TextDecoder();
  let scanned = '';
  deadline = setTimeout(cut, AI_GAP_MS);
  // `cancel` is in the Streams standard and Bun, not the DOM lib's `Transformer`.
  const meter: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
    transform(chunk, controller) {
      // Enqueued first, so metering never delays a token.
      controller.enqueue(chunk);
      clearTimeout(deadline);
      deadline = setTimeout(cut, AI_GAP_MS);
      scanned += decoder.decode(chunk, { stream: true });
      // `usage` is in the last frame, so the tail is kept. Halving instead of
      // trimming each chunk keeps the copying O(1) per byte.
      if (scanned.length > MAX_SCAN_BYTES) {
        scanned = scanned.slice(-MAX_SCAN_BYTES / 2);
      }
    },
    flush() {
      settle(tokensIn(scanned) ?? fallback);
    },
    // A mid-stream error or a cancelled read skips `flush`; this bills at once
    // instead of after the 90 s gap timer.
    cancel() {
      cut();
    },
  };
  const relayed = answer.body.pipeThrough(new TransformStream(meter));
  const response = new Response(relayed, {
    status: answer.status,
    headers: out,
  });
  // The slot bounds calls to the upstream, not how slowly a client reads. The
  // timers and the abort listener still bill once when the stream ends.
  slot();
  return response;
}
