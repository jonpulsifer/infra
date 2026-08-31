/**
 * `/api/ai`: an OpenAI-compatible passthrough with a per-site daily budget.
 *
 * The whole point is a key the site never sees. A page calls `/api/ai/v1/...`
 * on its own origin, this file puts the operator's `Authorization` on it and
 * relays the answer. Which means three things are not optional.
 *
 * **It is an allow-list, not a proxy.** Three upstream paths, by name. A blind
 * `/api/ai/*` would forward image and audio generation — endpoints priced per
 * second and per megapixel, with no `usage` field to meter — on a public
 * anonymous-write zone, paid by the operator.
 *
 * **Headers are rebuilt, never passed.** The client's `Authorization` is
 * dropped rather than overwritten, because a site that could append one would
 * be choosing the account; the query string is dropped for the same reason. On
 * the way back only `content-type` survives.
 *
 * **The budget is in Postgres, not in this process.** It is money, so a restart
 * must not hand every site a fresh 200 requests, and the check and the
 * increment are one statement so two calls in flight cannot both read the last
 * one as free.
 *
 * Bytes are relayed as they arrive — an SSE stream reaches the page token by
 * token — while a bounded *tail* of the answer is kept, because `usage` is in
 * the last chunk and keeping the head would silently under-bill every long
 * stream. An answer that states no usage is billed its clamped ceiling, which
 * is also what an aborted stream is billed. Never zero.
 */
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
/** Bun's connection idle timeout for these routes: a model thinks for longer. */
export const AI_IDLE_SECONDS = 120;
/** Concurrency, which is the cost ceiling a daily budget cannot express. */
export const MAX_AI_IN_FLIGHT_SITE = 4;
export const MAX_AI_IN_FLIGHT_ADDRESS = 2;
/** How much of an answer's tail is kept, to read `usage` out of it. */
const MAX_SCAN_BYTES = 1024 * 1024;
/** A crude proxy for tokenisation, used only where nothing better is on offer. */
const BYTES_PER_TOKEN = 4;

/** The upstream paths this server has. Everything else is a 404. */
const UPSTREAM = {
  '/chat/completions': 'POST',
  '/models': 'GET',
  '/embeddings': 'POST',
} as const;

type UpstreamPath = keyof typeof UPSTREAM;

/** Today, the way the `ai_usage` primary key spells it. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** What this site has spent today: `{requests, tokens}`, both numbers. */
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
 * Count one request against the day, or say the day is spent.
 *
 * One statement: the row is created at 1 or incremented only while both
 * ceilings still hold, so nothing between a read and a write can let a 201st
 * request through. No row comes back exactly when the budget is gone.
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

/**
 * What the answer actually cost, added once the answer is over.
 *
 * A failure here costs the operator money and the caller nothing, so it is
 * logged rather than raised: the response has already been sent.
 */
function bill(ctx: Ctx, name: string, day: string, tokens: number): void {
  if (tokens <= 0) return;
  void ctx.sql`
    update ai_usage set tokens = tokens + ${tokens}
    where site = ${name} and day = ${day}
  `.catch((cause: unknown) => logCause(ctx.id, 'billing ai tokens', cause));
}

// --- concurrency ------------------------------------------------------------

/**
 * Calls in flight, per site and per address.
 *
 * ponytail: a counter map in this process, like every other bucket here — there
 * is one replica by construction. Postgres advisory locks are the upgrade the
 * day there is a second.
 */
const inFlight = new Map<string, number>();

/** Take a slot in each of the named counters, or `null`. Call it to give back. */
function enter(
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

// --- the body ---------------------------------------------------------------

interface Prepared {
  /** The JSON this server sends, which is not byte-for-byte what it was sent. */
  readonly body: string;
  /** Billed when the answer carries no `usage` of its own. */
  readonly fallbackTokens: number;
}

/**
 * The client's JSON, with the four things this server decides put back in.
 *
 * `stream_options.include_usage` is the load-bearing one: without it a streamed
 * completion reports no usage at all and every stream would bill its ceiling.
 */
function prepare(
  ctx: Ctx,
  path: UpstreamPath,
  parsed: unknown,
): Prepared | 'MALFORMED_REQUEST' | 'INVALID_MODEL' {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'MALFORMED_REQUEST';
  }
  const body = parsed as Record<string, unknown>;

  const named = typeof body.model === 'string' ? body.model.trim() : '';
  const model = named === '' ? ctx.config.aiModel : named;
  // The allow-list is checked on embeddings too: a passthrough that policed
  // only `/chat/completions` would let any model in through the other door.
  if (ctx.config.aiModels.length > 0 && !ctx.config.aiModels.includes(model)) {
    return 'INVALID_MODEL';
  }
  const out: Record<string, unknown> = { ...body, model };
  if (path === '/embeddings') {
    // There is no `max_tokens` here and no completion to cap: what an embedding
    // costs is the input it was handed. A reply carrying no `usage` is billed a
    // byte-count proxy for that input rather than nothing — this was the one
    // door the never-billed-zero floor was missing.
    const serialised = JSON.stringify(out);
    return {
      body: serialised,
      fallbackTokens: Math.ceil(
        Buffer.byteLength(serialised) / BYTES_PER_TOKEN,
      ),
    };
  }

  // One completion per call. `n` multiplies the bill by a number the budget
  // cannot see until it has already been spent.
  if (body.n !== undefined && Number(body.n) !== 1) return 'MALFORMED_REQUEST';

  // Both spellings, independently. Clamping only the one this server picked and
  // writing only that back forwarded the other verbatim, so a body carrying
  // both bought a ceiling nobody here agreed to.
  let ceiling = 0;
  for (const key of ['max_tokens', 'max_completion_tokens'] as const) {
    if (body[key] === undefined) continue;
    const asked = Number(body[key]);
    const clamped =
      Number.isFinite(asked) && asked > 0
        ? Math.min(asked, ctx.config.aiMaxTokens)
        : ctx.config.aiMaxTokens;
    out[key] = clamped;
    ceiling = Math.max(ceiling, clamped);
  }
  // Neither spelling was sent: the ceiling is stated rather than left to the
  // upstream's own default.
  if (ceiling === 0) {
    out.max_tokens = ctx.config.aiMaxTokens;
    ceiling = ctx.config.aiMaxTokens;
  }

  if (body.stream === true) {
    const options =
      typeof body.stream_options === 'object' && body.stream_options !== null
        ? (body.stream_options as Record<string, unknown>)
        : {};
    out.stream_options = { ...options, include_usage: true };
  }
  // The most either spelling could have bought, so a body carrying both cannot
  // talk the billing floor down to the smaller of the two.
  return { body: JSON.stringify(out), fallbackTokens: ceiling };
}

/**
 * `usage.total_tokens` out of an answer, or `null`.
 *
 * A stream carries it in the last `data:` frame and a single response carries it
 * at the top level, so both are tried. The scan keeps the tail, so a stream past
 * {@link MAX_SCAN_BYTES} still reports its real usage; only a single response
 * that long parses as neither and falls back.
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

// --- the routes -------------------------------------------------------------

/**
 * Dispatch under `/api/ai`, with `segments` the split pathname.
 *
 * A leading `v1` is optional on the three upstream paths: the contract
 * publishes `/api/ai/v1` as the OpenAI base URL and `/api/ai/…` as the
 * shorthand its own docs use. `/api/ai/usage` is neither and takes no `v1`.
 */
export async function aiApi(
  request: Request,
  ctx: Ctx,
  name: string,
  segments: readonly string[],
  address: string | null,
): Promise<Response> {
  const tail = segments.slice(3);
  // Read first, and deliberately not under `/v1`: `usage` is this server's own
  // number, not an upstream path, and reading it spends nothing.
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
  // Answered here, and never relayed. A `no-cors` GET carries no `Origin`, so
  // the same-origin guard cannot see one either way: relaying this would leave
  // any third-party page able to spend a victim site's whole day on `<img
  // src=…/models>`. The allow-list is the whole truth about what this site may
  // ask for, so the local answer is also the more honest one.
  if (route === '/models') return models(ctx);

  let sent: Prepared = { body: '', fallbackTokens: 0 };
  if (UPSTREAM[route] === 'POST') {
    if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
    const body = await bodyOf(request, MAX_AI_BODY_BYTES);
    if ('code' in body) return refuse(body.code, ctx.id);
    const prepared = prepare(ctx, route, body.json);
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

/**
 * The models a site may name, in the shape the OpenAI SDK expects.
 *
 * Free and unmetered because it is this server's own list: a model outside
 * `KTHX_AI_MODELS` is a 400 anyway, so relaying the upstream's catalogue would
 * advertise models no site here can ask for and cost money to read.
 */
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

/** Today's numbers and the ceilings they are counted against. */
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
 * The call itself: rebuilt headers out, relayed bytes back, tokens billed once.
 *
 * Every way this ends — the last chunk, a cancelled read, a 90 s gap, the page
 * navigating away, an upstream that never answers — runs through `settle`, so
 * the day is charged exactly once. The in-flight slot is given back as soon as
 * the response is handed off, because it bounds calls to the upstream and not
 * how long a client takes to read one.
 */
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
    // Billed, not refunded: the request was counted at dispatch and this is a
    // deployment fault, not a caller's. It is one line in the log either way.
    logCause(ctx.id, 'the ai upstream', new Error('KTHX_AI_KEY is not set'));
    return refuse('AI_UPSTREAM', ctx.id);
  }

  // Built from nothing: the client's `Authorization`, cookies, `x-forwarded-*`
  // and query string are not dropped one by one, they are simply never here.
  const headers = new Headers({
    authorization: `Bearer ${key}`,
    'user-agent': 'kthx',
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
    settle(sent.fallbackTokens);
    logCause(ctx.id, `the ai upstream at ${path}`, cause);
    return refuse('AI_UPSTREAM', ctx.id);
  }
  clearTimeout(deadline);

  // The deployment's own credential failed. That is never the caller's to read
  // as 401, which would send a page looking for a token it does not have.
  if (answer.status === 401 || answer.status === 403) {
    void answer.body?.cancel();
    settle(0);
    logCause(
      ctx.id,
      'the ai upstream refused this deployment',
      new Error(`upstream ${answer.status}`),
    );
    return refuse('AI_UPSTREAM', ctx.id);
  }

  const out = new Headers({
    'content-type': answer.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': ctx.id,
  });
  // A refusal the upstream composed is relayed with its status, but it is not
  // an answer this site is charged tokens for.
  const fallback = answer.ok ? sent.fallbackTokens : 0;
  if (answer.body === null) {
    settle(fallback);
    return new Response(null, { status: answer.status, headers: out });
  }

  const decoder = new TextDecoder();
  let scanned = '';
  deadline = setTimeout(cut, AI_GAP_MS);
  // `cancel` is in the Streams standard and in Bun; the DOM lib's `Transformer`
  // predates it, so the type is widened rather than the handler dropped.
  const meter: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
    transform(chunk, controller) {
      // Enqueued first: nothing this file does may sit between a token the
      // upstream produced and the page waiting for it.
      controller.enqueue(chunk);
      clearTimeout(deadline);
      deadline = setTimeout(cut, AI_GAP_MS);
      scanned += decoder.decode(chunk, { stream: true });
      // The tail, because `usage` is in the last frame and keeping the head
      // billed every long stream its fallback instead. Halved rather than
      // trimmed every chunk, so a long answer still copies O(1) per byte.
      if (scanned.length > MAX_SCAN_BYTES) {
        scanned = scanned.slice(-MAX_SCAN_BYTES / 2);
      }
    },
    flush() {
      settle(tokensIn(scanned) ?? fallback);
    },
    // An upstream that errors mid-stream, or a client that cancels its read,
    // never reaches `flush`; without this the day is charged only once the
    // 90 s gap timer fires.
    cancel() {
      cut();
    },
  };
  const relayed = answer.body.pipeThrough(new TransformStream(meter));
  const response = new Response(relayed, {
    status: answer.status,
    headers: out,
  });
  // The slot bounds calls to the upstream, not how slowly a client reads its
  // answer: held until `flush`, four stalled readers closed a site's AI for
  // 90 s at a time. The timers and the abort listener still run, so the tokens
  // are billed exactly once whenever the stream actually ends.
  slot();
  return response;
}
