/**
 * `POST /api/build`: one sentence in, one HTML document out, streamed as ndjson.
 * Identity host only: every call spends the operator's AI plan under a login.
 * It never claims or publishes; the page does that through the sites API.
 */
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { enter, utcDay } from './ai.ts';
import { bodyOf, isPlainObject } from './documents.ts';
import {
  type Code,
  isJson,
  logCause,
  ok,
  problem,
  refuse,
  sameOrigin,
  siteUrl,
} from './http.ts';
import { secondsToMidnight } from './limits.ts';
import { nameProblem, RESERVED_NAMES } from './names.ts';
import { ensureRelease, releaseDir } from './releases.ts';
import { type Ctx, nameStanding, opensSite } from './sites.ts';

/** Room to describe a business, too small for a pasted document. */
export const MAX_ASK_CHARS = 4000;
/** Far more than any legal `{ask, site}` body, far less than the server's cap. */
const MAX_BUILD_BODY_BYTES = 64 * 1024;
/** A one-page site; a larger answer is refused. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
/**
 * Per login per UTC day, whichever runs out first. Rate limits only: the plan is
 * flat-rate. Nothing bounds the total across logins. 60 is a page every ten
 * minutes of a waking day; the token cap catches a model that reasons away its
 * ceiling.
 */
export const MAX_BUILD_REQUESTS_DAY = 60;
export const MAX_BUILD_TOKENS_DAY = 1_000_000;
/**
 * How long a model may think before its first byte. Set above the 149 s one
 * turn took under twelve concurrent generations.
 */
const FIRST_BYTE_MS = 150_000;
/**
 * Headers arrive in under a second even from a thinking model, so a missing
 * header means a bad base URL. Much shorter than {@link FIRST_BYTE_MS}.
 */
export const HEADERS_MS = 20_000;
const GAP_MS = 60_000;
/**
 * Seconds; a backstop for the {@link WAITING_MS} heartbeat, near Bun's 255 s
 * ceiling. The process-wide 30 s is shorter than this route's waits.
 */
const IDLE_SECONDS = 240;
/** How often a page is told how far along it is. */
const PROGRESS_MS = 250;
/**
 * A browser abandons a silent `fetch` long before a model's first byte, so a
 * quiet connection sends a frame this often.
 */
const WAITING_MS = 1_000;
/** Whole-page generations in flight, process-wide. */
const MAX_IN_FLIGHT = 4;

/** Lists {@link RESERVED_NAMES}, so the model avoids names a claim refuses. */
const SYSTEM = `You build small, complete websites as ONE self-contained HTML document.

Your answer is exactly two things, in this order and nothing else:
1. A first line that is only an HTML comment naming the site:
   <!-- kthx-name: some-short-name -->
   The name is 3 to 40 characters, lowercase letters, digits and single hyphens only, starting and ending with
   a letter or digit. Make it short and recognisable from what the person described. Never use any of these
   reserved names: ${[...RESERVED_NAMES].sort().join(' ')}.
2. The complete HTML document, starting with <!DOCTYPE html>.

No markdown fences, no commentary, no explanation.

Hard rules for the document:
- Everything inline: one <style> block, and a <script> only if the page truly needs one. NEVER reference an
  external URL for anything. Use system font stacks, CSS gradients, inline SVG and emoji instead of images.
- Invent NOTHING factual. Never write a testimonial, a review, an award, a year founded, an address, a price
  or a phone number the person did not give you. If a section needs a detail you were not given, write a short
  honest placeholder in square brackets.
- Responsive from 320px, semantic landmarks, one h1, real alt text, contrast that passes, and support
  prefers-color-scheme and prefers-reduced-motion.

When asked to change something, return the WHOLE answer again — the name comment and the whole document — with
only that change applied.`;

export async function buildUsage(
  ctx: Ctx,
  login: string,
  day = utcDay(),
): Promise<{ requests: number; tokens: number }> {
  const [row] = (await ctx.sql`
    select requests, tokens from build_usage
    where login = ${login} and day = ${day} limit 1
  `) as { requests: number; tokens: string | number }[];
  return {
    requests: Number(row?.requests ?? 0),
    tokens: Number(row?.tokens ?? 0),
  };
}

/** One statement, so concurrent calls cannot both take the last attempt. */
async function spendRequest(
  ctx: Ctx,
  login: string,
  day: string,
): Promise<boolean> {
  const spent = (await ctx.sql`
    insert into build_usage (login, day, requests, tokens)
    values (${login}, ${day}, 1, 0)
    on conflict (login, day) do update
      set requests = build_usage.requests + 1
      where build_usage.requests < ${MAX_BUILD_REQUESTS_DAY}
        and build_usage.tokens < ${MAX_BUILD_TOKENS_DAY}
    returning requests
  `) as { requests: number }[];
  return spent.length > 0;
}

function bill(ctx: Ctx, login: string, day: string, tokens: number): void {
  if (tokens <= 0) return;
  void ctx.sql`
    update build_usage set tokens = tokens + ${tokens}
    where login = ${login} and day = ${day}
  `.catch((cause: unknown) => logCause(ctx.id, 'billing build tokens', cause));
}

/** Only for deployment faults, the same rule `/api/ai` refunds under. */
function refundRequest(ctx: Ctx, login: string, day: string): void {
  void ctx.sql`
    update build_usage set requests = greatest(requests - 1, 0)
    where login = ${login} and day = ${day}
  `.catch((cause: unknown) =>
    logCause(ctx.id, 'refunding a build attempt', cause),
  );
}

const DOCTYPE = /<!doctype\s+html/i;
const CLOSE = '</html>';

/**
 * Takes the `<!doctype` … `</html>` span, dropping any prose or markdown fence
 * a model wrote around the document.
 */
export function documentIn(text: string): string | 'NO_DOCUMENT' | 'TOO_LARGE' {
  const start = text.search(DOCTYPE);
  if (start < 0) return 'NO_DOCUMENT';
  const end = text.toLowerCase().lastIndexOf(CLOSE);
  if (end < start) return 'NO_DOCUMENT';
  const document = text.slice(start, end + CLOSE.length);
  // Refused, never truncated: a cut document is a broken page.
  return Buffer.byteLength(document) > MAX_DOCUMENT_BYTES
    ? 'TOO_LARGE'
    : document;
}

const NAME_COMMENT = /^\s*<!--\s*kthx-name:\s*([^\s>]+)\s*-->/;

/**
 * The model's name comment may be missing or invalid, so it passes the claim's
 * {@link nameProblem} or falls back to a slug of what the person typed.
 */
export function nameIn(text: string, ask: string): string {
  const proposed = NAME_COMMENT.exec(text)?.[1]?.trim().toLowerCase() ?? '';
  return nameProblem(proposed) === null ? proposed : slugOf(ask);
}

/** Cut at a hyphen within 40 characters, so the slug ends on a word boundary. */
export function slugOf(ask: string): string {
  const words = ask
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut =
    words.length <= 40 ? words : words.slice(0, 41).replace(/-[^-]*$/, '');
  const trimmed = cut.replace(/-+$/, '');
  if (nameProblem(trimmed) === null) return trimmed;
  // The ask had no usable letters, or slugged to a reserved name.
  return `site-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Line-buffered, because a `data:` frame often spans TCP chunks. Only `content`
 * is read, so a model's `reasoning_content` never reaches a page.
 */
class Deltas {
  private held = '';
  private readonly decoder = new TextDecoder();
  /** `usage.total_tokens` from the last frame that carried one. */
  tokens: number | null = null;

  read(chunk: Uint8Array): string {
    this.held += this.decoder.decode(chunk, { stream: true });
    const lines = this.held.split('\n');
    this.held = lines.pop() ?? '';
    let written = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '' || payload === '[DONE]') continue;
      let frame: unknown;
      try {
        frame = JSON.parse(payload);
      } catch {
        continue;
      }
      if (!isPlainObject(frame)) continue;
      const usage = frame.usage;
      if (isPlainObject(usage) && typeof usage.total_tokens === 'number') {
        this.tokens = usage.total_tokens;
      }
      const choices = Array.isArray(frame.choices) ? frame.choices : [];
      for (const choice of choices) {
        if (!isPlainObject(choice)) continue;
        const delta = choice.delta;
        if (!isPlainObject(delta)) continue;
        if (typeof delta.content === 'string') written += delta.content;
      }
    }
    return written;
  }
}

/**
 * The Go base answers `400 MissingSessionID` without one. Hashed, because the
 * login is an email address and this appears in a third party's logs.
 */
function sessionOf(login: string): string {
  const digest = createHash('sha256').update(login).digest('hex');
  return `kthx-build-${digest.slice(0, 32)}`;
}

/** A model that has written its first content. */
interface Writing {
  readonly model: string;
  text: string;
  readonly deltas: Deltas;
  readonly body: ReadableStreamDefaultReader<Uint8Array>;
  /** Stops the upstream and charges the day once, never zero. */
  settle(): void;
  /** Extends the gap deadline; called on every chunk. */
  tick(): void;
}

type Attempt = Writing | { readonly code: Code };

/** What the stream keeps of the request once the response is open. */
interface Job {
  readonly login: string;
  /** Every attempt of this build counts against this UTC day. */
  readonly day: string;
  /** `null` for a new page with no name yet. */
  readonly site: string | null;
  readonly ask: string;
  /** The document being changed, or `null` for a new page. */
  readonly base: string | null;
}

/**
 * Asks one model and reads until it writes content. Any earlier failure comes
 * back as a code, so the caller only decides whether to try the next model.
 */
async function dispatch(
  ctx: Ctx,
  job: Job,
  model: string,
  messages: readonly { role: string; content: string }[],
  gone: AbortSignal,
): Promise<Attempt> {
  const { login, day } = job;
  const key = ctx.config.aiKey;
  if (key === null) {
    logCause(ctx.id, 'the build upstream', new Error('KTHX_AI_KEY is not set'));
    return { code: 'AI_UPSTREAM' };
  }
  // An attempt the ledger cannot count does not run. It reports
  // `STORAGE_FAILURE`, so nobody retries against a down database.
  const counted = await spendRequest(ctx, login, day).catch(
    (cause: unknown) => {
      logCause(ctx.id, 'counting a build attempt', cause);
      return null;
    },
  );
  if (counted === null) return { code: 'STORAGE_FAILURE' };
  if (!counted) return { code: 'AI_BUDGET' };

  const ceiling = ctx.config.aiBuildMaxTokens;
  const upstream = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => upstream.abort(),
    HEADERS_MS,
  );
  let done = false;
  const deltas = new Deltas();
  // Charges the day once. A failure before a body opens costs the operator
  // nothing and is billed nothing.
  const settle = (tokens: number): void => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    upstream.abort();
    bill(ctx, login, day, tokens);
  };
  // Usage comes only in the last frame, so any other end bills the ceiling. The
  // request day runs out first while `KTHX_AI_BUILD_MAX_TOKENS` ≤ 16 666.
  const spent = (): number => deltas.tokens ?? ceiling;
  const tick = (): void => {
    clearTimeout(deadline);
    deadline = setTimeout(() => upstream.abort(), GAP_MS);
  };
  // A closed page must not hold the person's slot until the first-byte deadline.
  // Checked as well as listened for: a listener on a fired signal never runs.
  if (gone.aborted) upstream.abort();
  gone.addEventListener('abort', () => upstream.abort(), { once: true });

  let answer: Response;
  try {
    answer = await fetch(`${ctx.config.aiUrl}/chat/completions`, {
      method: 'POST',
      // Built from scratch: no caller header reaches the upstream.
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'user-agent': 'kthx',
        'x-opencode-session': sessionOf(login),
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: ceiling,
        // Unstreamed, models on this base send nothing before a 420 s timeout.
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: upstream.signal,
    });
  } catch (cause) {
    // Nothing opened, so nothing is billed. The attempt is refunded unless the
    // caller aborted, or an abort loop could dial the upstream for free.
    settle(0);
    if (!gone.aborted) refundRequest(ctx, login, day);
    logCause(ctx.id, `the build upstream on ${model}`, cause);
    return { code: 'AI_UPSTREAM' };
  }

  clearTimeout(deadline);
  deadline = setTimeout(() => upstream.abort(), FIRST_BYTE_MS);

  if (!answer.ok) {
    void answer.body?.cancel();
    settle(0);
    // As on `/api/ai`, 401, 403 and 5xx are refunded. So are 404, since this
    // route builds every URL from `KTHX_AI_URL`, and 429, the plan's concurrency.
    const ours =
      answer.status === 401 ||
      answer.status === 403 ||
      answer.status === 404 ||
      answer.status === 429 ||
      answer.status >= 500;
    if (ours) refundRequest(ctx, login, day);
    logCause(
      ctx.id,
      `the build upstream on ${model} refused`,
      new Error(`upstream ${answer.status}`),
    );
    return { code: 'AI_UPSTREAM' };
  }

  if (answer.body === null) {
    // A 2xx with no body generated nothing: no tokens, and the attempt refunded.
    settle(0);
    refundRequest(ctx, login, day);
    logCause(
      ctx.id,
      `the build upstream on ${model}`,
      new Error('a 200 with no body'),
    );
    return { code: 'AI_UPSTREAM' };
  }

  const body = answer.body.getReader();
  // `fetch` may deliver a bodiless answer as an empty stream; closing before any
  // byte is refunded like a null body.
  // After the first byte the floor applies: reasoning frames are paid compute.
  let arrived = false;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof body.read>>;
    try {
      chunk = await body.read();
    } catch (cause) {
      // A rejected read bills the floor even with nothing received: the caller
      // hung up, or the deadline cut a model that may still have been reasoning.
      settle(spent());
      logCause(ctx.id, `reading from ${model}`, cause);
      return { code: 'AI_UPSTREAM' };
    }
    if (chunk.done || chunk.value === undefined) {
      if (!arrived) {
        settle(0);
        refundRequest(ctx, login, day);
        logCause(
          ctx.id,
          `the build upstream on ${model}`,
          new Error('a 200 with an empty body'),
        );
        return { code: 'AI_UPSTREAM' };
      }
      // It answered with no content. The attempt reached the upstream, so it
      // stays spent.
      settle(spent());
      return { code: 'AI_UPSTREAM' };
    }
    arrived = true;
    tick();
    const written = deltas.read(chunk.value);
    if (written !== '') {
      return {
        model,
        text: written,
        deltas,
        body,
        settle: () => settle(spent()),
        tick,
      };
    }
  }
}

/** The dispatcher admits only the identity host, so this checks only the login. */
export async function buildApi(
  request: Request,
  ctx: Ctx,
  segments: readonly string[],
): Promise<Response> {
  const login = ctx.caller.login;
  if (login === null) return refuse('UNAUTHENTICATED', ctx.id);

  if (segments.length === 4) {
    if (request.method !== 'GET') return refuse('METHOD_NOT_ALLOWED', ctx.id);
    return draft(ctx, login, segments[3] ?? '');
  }
  if (segments.length !== 3) return refuse('NOT_FOUND', ctx.id);
  if (request.method !== 'POST') return refuse('METHOD_NOT_ALLOWED', ctx.id);
  // The proxy sets the identity header on every request, so the credential is
  // ambient; without this a foreign page could spend the person's day.
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  return build(request, ctx, login);
}

/** Only to its author; anyone else gets a 404. */
async function draft(ctx: Ctx, login: string, id: string): Promise<Response> {
  const [row] = (await ctx.sql`
    select id, name, ask, site, document, at from builds
    where id::text = ${id} and owner_login = ${login} limit 1
  `) as {
    id: string;
    name: string;
    ask: string;
    site: string | null;
    document: string;
    at: Date;
  }[];
  if (row === undefined) return refuse('NOT_FOUND', ctx.id);
  return ok(
    {
      id: row.id,
      name: row.name,
      ask: row.ask,
      site: row.site,
      document: row.document,
      at: row.at.toISOString(),
    },
    ctx.id,
  );
}

async function build(
  request: Request,
  ctx: Ctx,
  login: string,
): Promise<Response> {
  const read = await bodyOf(request, MAX_BUILD_BODY_BYTES);
  if ('code' in read) return refuse(read.code, ctx.id);
  if (!isPlainObject(read.json)) return refuse('MALFORMED_REQUEST', ctx.id);
  const ask = typeof read.json.ask === 'string' ? read.json.ask.trim() : '';
  if (ask === '' || ask.length > MAX_ASK_CHARS) {
    return refuse('MALFORMED_REQUEST', ctx.id);
  }
  const named =
    typeof read.json.site === 'string'
      ? read.json.site.trim().toLowerCase()
      : null;

  let base: string | null = null;
  if (named !== null) {
    const opened = await changeable(ctx, named);
    if ('code' in opened) return refuse(opened.code, ctx.id);
    base = opened.document;
  }

  // One page at a time per person, so a phone with two tabs runs one generation.
  const slot = enter([
    [`build:${login}`, 1],
    ['build:*', MAX_IN_FLIGHT],
  ]);
  if (slot === null) {
    return refuse('RATE_LIMITED', ctx.id, { 'retry-after': '60' });
  }

  // This scope owns the slot until the hand-off, then the stream does. `finally`
  // releases it on every early exit, a failed budget read included.
  let handed = false;
  const day = utcDay();
  try {
    // Only a read: `dispatch` spends the attempt, and spending here too would
    // halve the day. The per-login slot keeps the read and the spend in order.
    const already = await buildUsage(ctx, login, day);
    if (
      already.requests >= MAX_BUILD_REQUESTS_DAY ||
      already.tokens >= MAX_BUILD_TOKENS_DAY
    ) {
      return refuse('AI_BUDGET', ctx.id, {
        'retry-after': String(secondsToMidnight()),
      });
    }
    ctx.server?.timeout(request, IDLE_SECONDS);
    handed = true;
    return streamed(request, ctx, { login, day, site: named, ask, base }, slot);
  } finally {
    if (!handed) slot();
  }
}

function conversation(
  ask: string,
  base: string | null,
): { role: string; content: string }[] {
  const system = { role: 'system', content: SYSTEM };
  if (base === null) return [system, { role: 'user', content: ask }];
  // One user turn: the instruction must come before the HTML, and some models
  // here refuse a replayed assistant turn.
  return [
    system,
    {
      role: 'user',
      content: `Change this website: ${ask}\n\nReturn the whole answer again — the name comment and the whole document — with only that change applied.\n\n--- the website as it stands ---\n${base}`,
    },
  ];
}

async function changeable(
  ctx: Ctx,
  name: string,
): Promise<{ document: string } | { code: Code }> {
  if (nameProblem(name) !== null) return { code: 'NOT_FOUND' };
  const [row] = (await ctx.sql`
    select s.token_hash, s.owner_login, s.serving, s.deleted_at, r.location
    from sites s
    left join releases r on r.site = s.name and r.n = s.serving
    where s.name = ${name} limit 1
  `) as {
    token_hash: string | null;
    owner_login: string | null;
    serving: number | null;
    deleted_at: Date | null;
    location: string | null;
  }[];
  if (row === undefined || row.deleted_at !== null) {
    return { code: 'NOT_FOUND' };
  }
  if (!opensSite(ctx.caller, row)) return { code: 'FORBIDDEN' };
  if (row.serving === null || row.location === null) {
    return { code: 'NOT_FOUND' };
  }
  const here = await ensureRelease(
    ctx.config.sitesDir,
    name,
    row.serving,
    row.location,
    ctx.depot,
  ).catch((cause: unknown) => {
    logCause(ctx.id, 'rehydrating a release to change it', cause);
    return false;
  });
  if (!here) return { code: 'BUSY' };

  const dir = releaseDir(ctx.config.sitesDir, name, row.serving);
  const entries = await readdir(dir, { recursive: true }).catch(() => null);
  // Only a single-page site: publishing one file over a site with assets would
  // strand its images in an old release.
  if (entries === null || entries.length !== 1 || entries[0] !== 'index.html') {
    return { code: 'NOT_FOUND' };
  }
  const page = Bun.file(join(dir, 'index.html'));
  // The answer's cap, applied to the question: a release may hold 32 MiB, and
  // this page is posted to the upstream once per model.
  if (page.size > MAX_DOCUMENT_BYTES) return { code: 'TOO_LARGE' };
  const document = await page.text().catch(() => null);
  return document === null ? { code: 'BUSY' } : { document };
}

/**
 * The status is 200 before any model is asked, so later failures are frames:
 * `accepted`, `thinking` each second (a new `model` is the fallback), `start`,
 * `writing`, then one terminal `done` or `error`. Every path runs `slot()`.
 */
function streamed(
  request: Request,
  ctx: Ctx,
  job: Job,
  slot: () => void,
): Response {
  const encoder = new TextEncoder();
  const models = [
    ctx.config.aiBuildModel,
    ctx.config.aiBuildFallbackModel,
  ].filter((model): model is string => model !== null);
  const messages = conversation(job.ask, job.base);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A reader that went away is the normal end of a closed page; the cleanup
      // below still runs.
      let writable = true;
      const send = (frame: Record<string, unknown>): void => {
        if (!writable) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          writable = false;
        }
      };

      const opened = Date.now();
      /** When a frame last went out; both silences are measured from it. */
      let told = opened;
      let asking: string | null = null;
      let writing: Writing | null = null;
      // Speaks after WAITING_MS of silence so no idle timer drops the socket. It
      // ticks at PROGRESS_MS, so an early tick cannot stretch a gap to 2 s.
      const heartbeat = setInterval(() => {
        if (Date.now() - told < WAITING_MS) return;
        if (writing !== null) {
          told = Date.now();
          send({ t: 'writing', chars: writing.text.length });
        } else if (asking !== null) {
          // `asking` is null only before the first model is asked.
          told = Date.now();
          send({ t: 'thinking', model: asking, ms: told - opened });
        }
      }, PROGRESS_MS);
      const cut = (): void => writing?.settle();
      request.signal.addEventListener('abort', cut, { once: true });

      try {
        send({ t: 'accepted' });
        let last: Code = 'AI_UPSTREAM';
        for (const model of models) {
          // A caller who left must not start the fallback: the listener in
          // `dispatch` is added after the abort and never runs.
          if (request.signal.aborted) break;
          asking = model;
          told = Date.now();
          send({ t: 'thinking', model, ms: told - opened });
          const attempt = await dispatch(
            ctx,
            job,
            model,
            messages,
            request.signal,
          );
          if (!('code' in attempt)) {
            // No await between these, so no `writing` frame precedes `start`.
            writing = attempt;
            told = Date.now();
            send({ t: 'start', model: attempt.model });
            break;
          }
          last = attempt.code;
          // A spent day or a down database fails the fallback too.
          if (last === 'AI_BUDGET' || last === 'STORAGE_FAILURE') break;
        }
        if (writing === null) {
          // Neither model wrote; a frame is the only way left to say why.
          send({ t: 'error', ...problem(last) });
          return;
        }
        for (;;) {
          const chunk = await writing.body.read();
          if (chunk.done || chunk.value === undefined) break;
          writing.tick();
          writing.text += writing.deltas.read(chunk.value);
          if (Date.now() - told >= PROGRESS_MS) {
            told = Date.now();
            send({ t: 'writing', chars: writing.text.length });
          }
        }
        send({ t: 'writing', chars: writing.text.length });
        send(await ending(ctx, job, writing.text));
      } catch (cause) {
        logCause(ctx.id, 'reading a build', cause);
        // Without a terminal frame the page spins forever.
        send({ t: 'error', ...problem('AI_UPSTREAM') });
      } finally {
        clearInterval(heartbeat);
        request.signal.removeEventListener('abort', cut);
        writing?.settle();
        slot();
        try {
          controller.close();
        } catch {
          // Already closed by the reader going away.
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': ctx.id,
    },
  });
}

/**
 * A failed insert is `STORAGE_FAILURE`, so nobody regenerates a page that was
 * written.
 */
async function ending(
  ctx: Ctx,
  job: Job,
  text: string,
): Promise<Record<string, unknown>> {
  const { login, site, ask, base } = job;
  const document = documentIn(text);
  if (document === 'NO_DOCUMENT' || document === 'TOO_LARGE') {
    return { t: 'error', ...problem(document) };
  }
  // An identical release would still take a number and push rollbacks back.
  if (base !== null && document === base) {
    return { t: 'done', build: null, name: site, site, unchanged: true };
  }

  const name = site ?? nameIn(text, ask);
  // The same answer as `GET /api/names/:name`, for this person: a name they
  // already hold is theirs, not taken.
  const standing = site === null ? await nameStanding(ctx, name) : null;
  const id = crypto.randomUUID();
  try {
    // Kept before any claim, so the page survives a phone locking while the
    // person confirms the name.
    await ctx.sql`
      insert into builds (id, owner_login, site, name, ask, document)
      values (${id}, ${login}, ${site}, ${name}, ${ask}, ${document})
    `;
  } catch (cause) {
    logCause(ctx.id, 'keeping a build', cause);
    return { t: 'error', ...problem('STORAGE_FAILURE') };
  }
  return {
    t: 'done',
    build: id,
    name,
    site,
    // `null` for a refine, so a page cannot read "taken" off its own site.
    available: standing?.available ?? null,
    // `empty` is this person's name with nothing published, which the page
    // finishes; `live` is their published site.
    yours: standing?.yours ?? null,
    url: siteUrl(ctx.config.zone, name, ctx.port),
    unchanged: false,
    document,
  };
}
