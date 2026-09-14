/**
 * `POST /api/build` — "build me a website for …".
 *
 * One sentence in, one complete HTML document out, streamed. It answers on the
 * identity host alone, because it is the only surface here where the caller is
 * a *person*: every call spends the operator's subscription and writes a row
 * under a login, and neither has a meaning for an anonymous visitor.
 *
 * Four things about the upstream are not preferences.
 *
 * **Streaming is mandatory.** Measured on this base: four models asked for a
 * whole page without `stream` returned zero bytes at a 420 s timeout, and the
 * same four streamed a first byte in under five seconds. A non-streamed build
 * is not slower, it never arrives.
 *
 * **The response opens when the request is accepted, not when the model
 * writes.** Held to the first content byte it was 71-95 s of empty socket,
 * measured twice in production against the real model, and a browser abandons a
 * `fetch` long before that: it rejects with a `TypeError` whose message is its
 * own and not this server's. "It could not be written / Load failed" on
 * somebody's screen was exactly that — a 200 that arrived after nobody was
 * listening any more. So everything decided cheaply and without the upstream
 * stays a status (the body, the login, the origin, a site too big to hand back,
 * the in-flight slot, the day's budget) and the moment those pass the answer is
 * 200 and a stream. After that **nothing is a status**: an unreachable base, a
 * refusal, a model that spends its whole ceiling reasoning and writes nothing,
 * both models failing — all of it is a frame on a response that is already
 * open.
 *
 * **A reasoning model is working, not idle, and the page is told so.** A frame
 * goes out the moment the request is accepted and another every
 * {@link WAITING_MS} the model stays quiet, so this connection is never idle
 * for longer than a second and the screen can narrate the wait instead of
 * spinning through it. That, rather than `server.timeout`, is now what stands
 * between a slow model and a socket closed with no status, no body and no log
 * line.
 *
 * **Nothing the model says is trusted.** The name comment is absent on about
 * one prompt in six on the fallback model, so it is parsed, validated against
 * the same rules a claim enforces, and replaced by a slug of what the person
 * typed. The document is taken as the `<!doctype` … `</html>` span or refused;
 * an answer is not a file merely because a model ended it with one.
 *
 * ## The frames
 *
 * One JSON object a line, newline-terminated, `application/x-ndjson`, in this
 * order. The page after this file builds against exactly this and nothing else:
 *
 * ```
 * {"t":"accepted"}                                   once, first, before anything is dialled
 * {"t":"thinking","model":"kimi-k2.7-code","ms":0}   asked, nothing written yet; once a second until it
 *                                                    writes, and again with a new model for the fallback
 * {"t":"start","model":"kimi-k2.7-code"}             its first content byte arrived; at most one per response
 * {"t":"writing","chars":2140}                       raw characters written; at most one every 250 ms, and
 *                                                    once a second even when a model has gone quiet
 * {"t":"done","build":"<uuid>","name":"pulsifer-woodworking","site":null,"available":true,"yours":null,
 *  "url":"https://…","unchanged":false,"document":"<!doctype html>…"}
 * {"t":"error","code":"AI_UPSTREAM","message":"the ai upstream did not answer"}
 * ```
 *
 * "Once a second" is a floor of {@link WAITING_MS} between two frames and a
 * ceiling of that plus one {@link PROGRESS_MS} tick, so nothing downstream
 * should watchdog this at a flat second and call 1.2 s a dropped connection.
 *
 * `accepted` carries nothing, because it *is* the acknowledgement: the cheap
 * gates passed and this response is 200 whatever happens next. `thinking` names
 * the model being waited on and the milliseconds since `accepted`, so a screen
 * counts this server's clock rather than its own, and a change of `model`
 * between two of them **is** the fallback signal — there is no separate frame
 * for it. `writing` counts raw model output, the name comment included and
 * before {@link documentIn} takes the span, so it is progress and not a
 * document length.
 *
 * `done` and `error` are terminal and mutually exclusive: exactly one of them
 * ends any response that had a stream at all, nothing follows it, and a body
 * that ends with neither is a caller who went away. The one `done` that is not
 * the shape above is `unchanged:true` — a change whose answer is byte-for-byte
 * what the site already serves — which carries only `build:null`, `name`,
 * `site` and `unchanged`, because there is nothing to publish and no row was
 * written. An `error` carries `{code,message}`, the same pair and the same
 * fixed sentence per code a status body would have carried: `AI_UPSTREAM`,
 * `NO_DOCUMENT`, `TOO_LARGE`, `STORAGE_FAILURE`, and `AI_BUDGET` for a day that
 * filled between the check and the attempt, which only two pods can arrange.
 *
 * Nothing here claims a name and nothing here publishes. The page confirms the
 * name with the person and then uses `POST /api/sites` and
 * `POST /api/sites/:name/releases` — identity already made the browser an
 * authenticated caller, so every bound those routes carry applies unchanged
 * instead of being re-established by a second publishing seam that would miss
 * the next one added.
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

/** A sentence about a business, not a document paste. */
export const MAX_ASK_CHARS = 4000;
/** Far more than any legal `{ask, site}` body, far less than the server's cap. */
const MAX_BUILD_BODY_BYTES = 64 * 1024;
/** A one-page site. Past this the answer is not a page, it is a transcript. */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
/**
 * What one login may spend on the builder in a UTC day, whichever runs out
 * first.
 *
 * Rate limits, not a spend control. The upstream plan is flat rate and reports
 * `cost: "0"` on every call, so neither number is money: what they bound is a
 * page left reloading in somebody's pocket and a key somebody else is holding.
 * Sixty pages is one every ten minutes of a waking day, which nobody reaches
 * by describing a business; the token half is the backstop for the failure
 * this base actually has, a model that spends its whole ceiling reasoning and
 * writes nothing, which costs what a page costs and produces none.
 *
 * **Nothing bounds the total across logins.** `build_usage` is keyed by login,
 * and the in-flight counters below bound how many run at once rather than how
 * many run in a day, so the ceiling for the whole tailnet is sixty pages times
 * the number of people the `policy.hujson` grant lets through — a household.
 * Growing that grant grows the day, and there is no second number here that
 * would stop it.
 */
export const MAX_BUILD_REQUESTS_DAY = 60;
export const MAX_BUILD_TOKENS_DAY = 1_000_000;
/**
 * How long a model may think before it has written anything, and how long a
 * gap in its writing may be.
 *
 * Measured in production on the model this runs: 71.9 s and 94.7 s to the first
 * content byte. Ninety seconds sat *inside* that range — it would have cut the
 * second of those a breath before it answered and spent the fallback's whole
 * generation to get a page the primary was already writing. There is nothing
 * left to be impatient for now that the wait is narrated a second at a time, so
 * the deadline goes past the measured worst case instead of through the middle
 * of it. Under twelve concurrent generations a single turn ran 149 s end to
 * end, which is the number this is set against.
 */
const FIRST_BYTE_MS = 150_000;
/**
 * How long the upstream has to answer with headers at all.
 *
 * A separate, much shorter clock than {@link FIRST_BYTE_MS}, because the two
 * silences mean opposite things. A model that has sent headers and is quiet is
 * thinking, and the measured wait for its first word is 71-95 s. A base that
 * has not sent headers is not thinking — it is a name that does not resolve or
 * a host that is not listening, and no amount of waiting improves it.
 *
 * One clock for both made a mis-set `KTHX_AI_URL` take 268 s to say so: 133 s
 * on the primary and 135 s again on the fallback, every second of it narrated
 * to somebody watching a page claim it was writing. Measured on this base,
 * headers arrive in well under a second even when the first word is a minute
 * and a half behind them.
 */
export const HEADERS_MS = 20_000;
const GAP_MS = 60_000;
/**
 * Bun's connection idle timeout for this route, in seconds.
 *
 * The belt, not the braces: {@link WAITING_MS} is what actually keeps this
 * socket busy, and this is what remains true if a later edit takes the
 * heartbeat out or the process is too busy to run a timer. Set near Bun's own
 * ceiling of 255 s because the alternative is the process-wide floor of 30 s,
 * and every measured number about this route — 71-95 s to a first content byte,
 * 30-150 s end to end — is longer than that.
 */
const IDLE_SECONDS = 240;
/** How often a page is told how far along it is. */
const PROGRESS_MS = 250;
/**
 * How often a connection with nothing to report says something anyway.
 *
 * This route goes quiet in two different ways and neither of them is idleness:
 * before a model's first content byte, where production measured 71.9 s and
 * 94.7 s of empty socket, and in a gap between one word of an answer and the
 * next, which may run to {@link GAP_MS}. A browser gives up on the first long
 * before the model does and rejects the `fetch` with a sentence of its own
 * making. One line a second costs about forty bytes, keeps every timer between
 * here and the phone satisfied, and turns the wait into something the page can
 * say out loud.
 */
const WAITING_MS = 1_000;
/** Whole-page generations in flight, process-wide and per person. */
const MAX_IN_FLIGHT = 4;

/**
 * What the model is told, once.
 *
 * Measured against six prompts a non-technical person would type: 6/6 valid
 * names and 6/6 clean single documents on the default model, and every model
 * that answered at all obeyed the no-external-URLs and no-invented-facts rules.
 * The reserved names are rendered from {@link RESERVED_NAMES} rather than typed
 * out again — a prompt that lists a different set is a proposal the claim
 * refuses, which costs the person a name they were already shown.
 */
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

// --- the budget -------------------------------------------------------------

/** What this login has spent today: `{requests, tokens}`, both numbers. */
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

/**
 * Count one attempt against the day, or say the day is spent.
 *
 * One statement, for the reason `ai_usage` is: the row is created at 1 or
 * incremented only while both ceilings still hold, so two calls in flight
 * cannot both read the last one as free.
 */
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

/**
 * The attempt this call spent, given back — only when the fault was ours.
 *
 * The same rule `/api/ai` refunds under, and for the same reason: an upstream
 * 401, a 403 or any 5xx is a credential or a base URL this deployment owes the
 * upstream, and a person who asked for sixty pages did not get one of them. An
 * upstream that answered is never refunded, because the day is the only ceiling
 * on outbound calls there is.
 */
function refundRequest(ctx: Ctx, login: string, day: string): void {
  void ctx.sql`
    update build_usage set requests = greatest(requests - 1, 0)
    where login = ${login} and day = ${day}
  `.catch((cause: unknown) =>
    logCause(ctx.id, 'refunding a build attempt', cause),
  );
}

// --- what comes back --------------------------------------------------------

const DOCTYPE = /<!doctype\s+html/i;
const CLOSE = '</html>';

/**
 * The document inside an answer, or why there is not one.
 *
 * The model's answer is prose that is *supposed* to be a file, which is not the
 * same thing: a stray sentence before the doctype, a markdown fence after the
 * close, a model that narrated instead. Taking the span rather than the whole
 * answer is what makes a chatty model publishable and a silent one refused.
 */
export function documentIn(text: string): string | 'NO_DOCUMENT' | 'TOO_LARGE' {
  const start = text.search(DOCTYPE);
  if (start < 0) return 'NO_DOCUMENT';
  const end = text.toLowerCase().lastIndexOf(CLOSE);
  if (end < start) return 'NO_DOCUMENT';
  const document = text.slice(start, end + CLOSE.length);
  // Refused rather than cut: a truncated document is a broken page that looks
  // like a published one.
  return Buffer.byteLength(document) > MAX_DOCUMENT_BYTES
    ? 'TOO_LARGE'
    : document;
}

const NAME_COMMENT = /^\s*<!--\s*kthx-name:\s*([^\s>]+)\s*-->/;

/**
 * The name the model proposed, or one made from what the person typed.
 *
 * Never trusted to be there: the fallback model dropped the comment entirely on
 * one of six measured prompts, and a model that forgets the protocol must not
 * be a dead end on somebody's screen. Validated against the same
 * {@link nameProblem} a claim runs, so the name the page offers is one the
 * claim will actually take.
 */
export function nameIn(text: string, ask: string): string {
  const proposed = NAME_COMMENT.exec(text)?.[1]?.trim().toLowerCase() ?? '';
  return nameProblem(proposed) === null ? proposed : slugOf(ask);
}

/**
 * A name out of a sentence.
 *
 * Cut on a hyphen rather than at 40 characters, so the fallback reads as words
 * somebody wrote rather than one sliced in half. It is a fallback and not a
 * proposal: the page shows it with the URL it becomes and a way to change it.
 */
export function slugOf(ask: string): string {
  const words = ask
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut =
    words.length <= 40 ? words : words.slice(0, 41).replace(/-[^-]*$/, '');
  const trimmed = cut.replace(/-+$/, '');
  if (nameProblem(trimmed) === null) return trimmed;
  // A sentence with no letters in it, or one that slugged to a reserved word.
  return `site-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The content deltas out of a streamed answer, and the usage at the end of it.
 *
 * Line-buffered because a `data:` frame is split across TCP chunks as often as
 * not and half a JSON object parses as nothing at all. Only `content` is read:
 * every model on this base but one puts its reasoning in `reasoning_content`,
 * and an answer built out of both would carry a model's thinking into somebody's
 * published page.
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

// --- the upstream -----------------------------------------------------------

/**
 * The upstream's session id for this person.
 *
 * The Go base answers `400 MissingSessionID` without one. Hashed because the
 * value lands in a third party's logs and the input here is somebody's email
 * address, which is no more their business than a site's token would be.
 */
function sessionOf(login: string): string {
  const digest = createHash('sha256').update(login).digest('hex');
  return `kthx-build-${digest.slice(0, 32)}`;
}

/** A model that started writing: the first of the answer, and the rest to come. */
interface Writing {
  readonly model: string;
  /** Everything written so far, first content delta included. */
  text: string;
  readonly deltas: Deltas;
  readonly body: ReadableStreamDefaultReader<Uint8Array>;
  /** Stop the upstream and the deadline, and charge the day once, never zero. */
  settle(): void;
  /** Extend the deadline, called on every chunk. */
  tick(): void;
}

type Attempt = Writing | { readonly code: Code };

/**
 * Everything the stream needs that the request itself already settled.
 *
 * Carried as one value because by the time a model is asked anything the
 * response is open and this is all that is left of the request: passing six
 * loose arguments through the hand-off is how one of them ends up being the
 * wrong person's.
 */
interface Job {
  readonly login: string;
  /** The UTC day every attempt of this build is counted against. */
  readonly day: string;
  /** The site a change is about, or `null` for a page with no name yet. */
  readonly site: string | null;
  /** What the person typed. */
  readonly ask: string;
  /** The document a change is being made to, or `null` for a new page. */
  readonly base: string | null;
}

/**
 * One model, asked, and read until it writes something.
 *
 * Everything before the first content delta is this function's problem, so its
 * caller has one thing to decide — whether to try the next model — rather than
 * a taxonomy of upstream faults: a refusal, an upstream that cannot be reached,
 * a model that spends its whole ceiling reasoning and emits no content at all,
 * which measured, four models on this base do exactly that. None of them is a
 * status any more; the response was open before this was called.
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
  // The ledger is the only thing bounding what this key spends, so an attempt
  // it cannot count is an attempt that does not run. Caught rather than thrown
  // because the caller is a stream: an exception here would reach the page as
  // "the ai upstream did not answer", which would send somebody to press the
  // button again against a control database that is the thing that is down.
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
  // Headers first, on the short clock. It is replaced by the long one the
  // moment they arrive, so a model may then think for as long as a model does.
  let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => upstream.abort(),
    HEADERS_MS,
  );
  let done = false;
  const deltas = new Deltas();
  /**
   * The day, charged exactly once, with what the upstream actually did.
   *
   * The argument is the whole of it, and `/api/ai` is where the lesson was
   * learned: everything that fails before a body is open — an unreachable
   * base, a 401 on a key with no credit, a 503 — cost the operator nothing and
   * is billed nothing. Billing the ceiling there charged sixteen thousand
   * tokens for an outage the person did not cause, and thirty-one of those
   * close a day that never wrote a page.
   */
  const settle = (tokens: number): void => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    upstream.abort();
    bill(ctx, login, day, tokens);
  };
  /**
   * What an upstream that opened a body is billed: never zero.
   *
   * Usage arrives in the frame before `[DONE]` and a stream that ends any
   * other way carries none, so without the floor a model that reasoned for its
   * whole ceiling and wrote nothing — measured, four on this base do — would
   * be free, and so would every stream a reader walked away from.
   *
   * **A phone that backgrounds itself mid-generation is billed the ceiling,
   * deliberately.** It is the common way this ends — the wait is 30-150 s and
   * this page is used one-handed — and it is tempting to make it free. Two
   * things settle it against that. There is no honest smaller number: the
   * upstream generated, the usage frame never arrives, and anything else here
   * would be a guess dressed as a measurement. And the harm the refund would
   * avoid is already bounded elsewhere: an abandoned build breaks the model
   * loop, so it spends one attempt and one ceiling, and
   * {@link MAX_BUILD_REQUESTS_DAY} × ceiling — 60 × 16 000 — is under
   * {@link MAX_BUILD_TOKENS_DAY}. Sixty abandoned builds cannot close the
   * token day before the request day it already closed. Raising
   * `KTHX_AI_BUILD_MAX_TOKENS` past ~16 600 is what would change that, and it
   * is the ceiling to re-read this paragraph against.
   */
  const spent = (): number => deltas.tokens ?? ceiling;
  const tick = (): void => {
    clearTimeout(deadline);
    deadline = setTimeout(() => upstream.abort(), GAP_MS);
  };
  // A page that was closed while a model was thinking holds this person's one
  // in-flight slot until the first-byte deadline otherwise, so the next thing they
  // do after reopening the tab is read "one at a time". Checked as well as
  // listened for: a listener added to a signal that has already fired never
  // runs, which is how a closed tab paid for a whole second generation on the
  // fallback model.
  if (gone.aborted) upstream.abort();
  gone.addEventListener('abort', () => upstream.abort(), { once: true });

  let answer: Response;
  try {
    answer = await fetch(`${ctx.config.aiUrl}/chat/completions`, {
      method: 'POST',
      // Built from nothing: no header a caller sent reaches the upstream.
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
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: upstream.signal,
    });
  } catch (cause) {
    // Nothing was opened, so nothing is billed. Unreachable is the same fault
    // as a 503 and the attempt goes back with it — unless the caller is what
    // went away, which is nobody's deployment fault and must not be free: an
    // abort loop that got its attempt back would dial the upstream all day
    // under a budget that never moved.
    settle(0);
    if (!gone.aborted) refundRequest(ctx, login, day);
    logCause(ctx.id, `the build upstream on ${model}`, cause);
    return { code: 'AI_UPSTREAM' };
  }

  // Headers are in: the base is real and listening, and what is left to wait
  // for is a model, on the clock a model needs.
  clearTimeout(deadline);
  deadline = setTimeout(() => upstream.abort(), FIRST_BYTE_MS);

  if (!answer.ok) {
    void answer.body?.cancel();
    // It refused before writing anything, so there are no tokens to charge.
    settle(0);
    // Whose fault it was decides whether the attempt comes back, and it is the
    // rule `/api/ai` was hardened to after the first version turned out to be
    // exploitable in production. 401, 403 and every 5xx are a credential or a
    // base URL this deployment owes the upstream. Every other 4xx is about the
    // body — here, one built around a document this route sent — and it keeps
    // the attempt it spent, because a refusal that is free to earn is one that
    // can be asked for forever, and the sixty a day is the only ceiling on
    // outbound calls there is.
    //
    // Two of those 4xx are this deployment's here and are not on `/api/ai`,
    // because that route forwards a path the caller picked and this one builds
    // the whole URL out of `KTHX_AI_URL`. A **404** is therefore only ever a
    // mis-set base — measured, a wrong path on this upstream answers 404 with
    // a marketing page rather than a 5xx — and thirty presses against one
    // would close a day in which nobody wrote a page, which is the exact end
    // state this rule exists to prevent, moved from the token column to the
    // request column. A **429** is the plan's concurrency, not the sentence
    // somebody typed: nothing in this body is the caller's to change.
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
    // Nothing was opened, so nothing is billed — the same rule as an
    // unreachable base. The floor above it is for an upstream that *opened a
    // body* and said nothing through it; a 2xx with no stream behind it is
    // this deployment's upstream misbehaving on a URL and a model that are
    // both its own, and charging both the ceiling and the attempt for a
    // generation that never started is that rule applied backwards.
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
  // Whether one byte ever came over the wire. A body that *closes* without any
  // is the bodiless answer above arriving the way `fetch` actually hands one
  // over — an empty stream rather than a null — and a clean close with nothing
  // in it is an upstream that generated nothing, so it is billed nothing and
  // the attempt goes back with it. Once a byte has arrived the floor applies: a
  // model that spends its whole ceiling reasoning still sends
  // `reasoning_content` frames, and that is compute somebody's subscription
  // paid for whether or not a page came out of it.
  let arrived = false;
  for (;;) {
    let chunk: Awaited<ReturnType<typeof body.read>>;
    try {
      chunk = await body.read();
    } catch (cause) {
      // A read that rejects is not a clean close, and it bills the floor even
      // with nothing yet on the wire. Two things reach here: the caller hung up
      // (which pays, or an abort loop is free to dial the upstream all day),
      // and the first-byte deadline cut a model that has flushed nothing —
      // which on this base is what a model *working* looks like, measured up to
      // 161 s to a first byte with the whole ceiling being spent on reasoning
      // behind it. Silence is not proof that nothing was generated; a body that
      // closed empty is.
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
      // It answered, and wrote nothing. The attempt is not refunded: it reached
      // the upstream and spent the operator's quota to say nothing.
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

// --- the route --------------------------------------------------------------

/**
 * Dispatch under `/api/build`, with `segments` the split pathname.
 *
 * The caller has already refused every host but the identity one, so this file
 * never has to ask which door it is behind — only who came through it.
 */
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
  // An identity header is set by the proxy on whatever reaches it, so the
  // credential is ambient the moment a browser is on this host: without this a
  // foreign page spends somebody's whole day from their own address bar.
  if (!sameOrigin(request, ctx.host, ctx.port)) {
    return refuse('FORBIDDEN', ctx.id);
  }
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  return build(request, ctx, login);
}

/** One draft, to its own author. Anyone else is told there is nothing here. */
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

  // One page at a time per person, and four in this process: a whole-page
  // generation is a minute of somebody else's compute, and a phone with two
  // tabs open must not be two of them.
  const slot = enter([
    [`build:${login}`, 1],
    ['build:*', MAX_IN_FLIGHT],
  ]);
  if (slot === null) {
    return refuse('RATE_LIMITED', ctx.id, { 'retry-after': '60' });
  }

  // The slot has exactly one owner at a time. Until the response opens it
  // belongs to this scope, and `finally` gives it back however the scope ends —
  // including through an exception, which is not hypothetical: the budget below
  // reads the control database, a CNPG failover rejects that await, and the
  // release used to be skipped. One of those left that login reading "one at a
  // time" for the life of the pod and four of them closed the builder for
  // everybody. After the hand-off the stream owns it and gives it back when it
  // ends, so this must not release it twice.
  let handed = false;
  const day = utcDay();
  try {
    // The last thing that can still be a status, and the reason it is a read
    // rather than the spend itself: the attempt is counted inside `dispatch`
    // under the one statement that cannot let two callers both read the last
    // one as free, and counting it here as well would halve the day. The
    // per-login slot above is what keeps this read and that spend from crossing
    // inside this process. Two pods can still cross, and the loser is told in a
    // frame instead of a status — which is the rule this whole route now runs
    // on.
    const already = await buildUsage(ctx, login, day);
    if (
      already.requests >= MAX_BUILD_REQUESTS_DAY ||
      already.tokens >= MAX_BUILD_TOKENS_DAY
    ) {
      return refuse('AI_BUDGET', ctx.id, {
        'retry-after': String(secondsToMidnight()),
      });
    }
    // Belt for the heartbeat: a connection here is written to every second, so
    // it should never go idle at all, and the process-wide floor of 30 s is
    // under every measured number this route has.
    ctx.server?.timeout(request, IDLE_SECONDS);
    handed = true;
    return streamed(request, ctx, { login, day, site: named, ask, base }, slot);
  } finally {
    if (!handed) slot();
  }
}

/** What the model is asked, new or changed. */
function conversation(
  ask: string,
  base: string | null,
): { role: string; content: string }[] {
  const system = { role: 'system', content: SYSTEM };
  if (base === null) return [system, { role: 'user', content: ask }];
  // One user turn rather than a replayed assistant turn: the instruction has to
  // come before thirty kilobytes of HTML or it is read last, and a two-message
  // history is a shape some models on this base refuse outright.
  return [
    system,
    {
      role: 'user',
      content: `Change this website: ${ask}\n\nReturn the whole answer again — the name comment and the whole document — with only that change applied.\n\n--- the website as it stands ---\n${base}`,
    },
  ];
}

/** The site a refine is about, and the document it is changing. */
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
  // Exactly one file, and it is the page. A site with assets was not written
  // here, and publishing one file over it would leave every image of it in a
  // release nobody is looking at.
  if (entries === null || entries.length !== 1 || entries[0] !== 'index.html') {
    return { code: 'NOT_FOUND' };
  }
  const page = Bun.file(join(dir, 'index.html'));
  // The same cap the answer is held to, applied to the question. The release
  // route takes 32 MiB unpacked, which is sixty-four of these, and a document
  // that size is one press of "Change it" reading thirty megabytes into this
  // pod and posting it to the upstream once per model — for a refusal the
  // caller now keeps, because a 4xx the body earned is no longer refunded.
  if (page.size > MAX_DOCUMENT_BYTES) return { code: 'TOO_LARGE' };
  const document = await page.text().catch(() => null);
  return document === null ? { code: 'BUSY' } : { document };
}

/**
 * The answer, from the moment the request is accepted to the row that survives
 * a closed tab.
 *
 * The status is 200 before any model has been asked anything, so nothing below
 * may be a status: a base that cannot be reached, a model that refuses, a model
 * that stops mid-document, an answer with no document in it and a client that
 * navigated away are all one frame or one silence. What must still happen on
 * every one of those paths is `settle`, which charges the day exactly once, and
 * `slot()`, which belongs to this stream from the moment it is constructed and
 * to nothing else.
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
      // A frame written to a reader that has gone is not an error to handle,
      // it is the ordinary end of a page somebody closed. Everything after it
      // still has to run: the day is charged and the slot given back below.
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
      /** When anything last went out, which is what both silences are measured from. */
      let told = opened;
      /** The model being waited on, named in every frame of its silence. */
      let asking: string | null = null;
      /** The model that started writing, and everything it has written. */
      let writing: Writing | null = null;
      // The one timer that keeps this connection from ever being quiet, in
      // either of the two ways it goes quiet — before a model's first content
      // byte, and in a gap between one word of its answer and the next. Neither
      // is idleness: the upstream is generating through both, and a socket that
      // says so is one no browser, proxy or idle timer walks away from. It
      // writes nothing while chunks are arriving, because `told` moves every
      // PROGRESS_MS down there.
      //
      // It ticks at the progress cadence and speaks at the waiting one on
      // purpose. Ticking at WAITING_MS instead would halve the rate whenever a
      // tick landed a millisecond early — the guard would skip it and the next
      // word would be two seconds later — and a heartbeat whose interval is
      // really "one or two seconds, depending" is one nothing downstream can be
      // sized against.
      const heartbeat = setInterval(() => {
        if (Date.now() - told < WAITING_MS) return;
        if (writing !== null) {
          told = Date.now();
          send({ t: 'writing', chars: writing.text.length });
        } else if (asking !== null) {
          // Never a `thinking` frame with a null model: `asking` is unset only
          // in the window before the first model is asked, which closes with no
          // await in it, and a frame naming nobody is one the page would have
          // to have a sentence for.
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
          // A caller who has gone away must not start new work on the
          // operator's account. The abort listener inside `dispatch` cannot
          // cover this: for the fallback the signal has already fired, and a
          // listener added after that never runs — which is how a closed tab
          // paid for a second whole generation, streamed into a response
          // nothing was reading.
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
            // Taken and announced with no await between them, so the heartbeat
            // cannot put a `writing` frame in front of the `start` that
            // explains it.
            writing = attempt;
            told = Date.now();
            send({ t: 'start', model: attempt.model });
            break;
          }
          last = attempt.code;
          // A day that is spent is spent for the fallback too, and a control
          // database that would not count this attempt will not count the next
          // one either.
          if (last === 'AI_BUDGET' || last === 'STORAGE_FAILURE') break;
        }
        if (writing === null) {
          // Every way of never getting a word out of either model, arriving on
          // a response that has been open and talking since the first
          // millisecond. There is no status left to send and nothing to
          // publish, so the page is told which refusal it was in the one frame
          // it can still read.
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
        // A page that was told nothing is a page that spins forever.
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
 * The last frame: a document and a name, a refusal, or nothing to publish.
 *
 * A database that will not take the row is its own frame rather than the
 * upstream's: the page was written, and telling somebody the writer failed
 * would send them to write it again.
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
  // A release that changes nothing is still a release: it takes a number, it
  // takes a slot, and it makes the next rollback one step further away.
  if (base !== null && document === base) {
    return { t: 'done', build: null, name: site, site, unchanged: true };
  }

  const name = site ?? nameIn(text, ask);
  // Asked of the same routine `GET /api/names/:name` answers with, so the page
  // is told the same thing whichever way it asks — and told it about *this*
  // person: a name he already holds is not a name that belongs to somebody
  // else, and offering it to him as one is what spent the first address.
  const standing = site === null ? await nameStanding(ctx, name) : null;
  const id = crypto.randomUUID();
  try {
    // Written the moment there is a document and before anything is claimed,
    // because a claim is a real Postgres database and a person confirms the
    // name first: the minutes between "here is your page" and "put it online"
    // are the ones a phone locks in, and they survive here.
    //
    // A tab discarded *while* a model is writing is not one of them, and no
    // row can make it one. The generation stops when the socket does, by
    // design — the alternative is finishing a page for nobody on the
    // operator's subscription — so there is nothing complete to keep and a
    // partial document is not a site. What was typed is the browser's to hold
    // on to; this table holds pages.
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
    // Meaningless for a refine, and null rather than false so a page cannot
    // read "this name is taken" off a site it already owns.
    available: standing?.available ?? null,
    // `empty` is an address of his with nothing on it — the claim a failed
    // upload stranded, which the page finishes rather than renaming — and
    // `live` is a website of his, which is a different sentence again and
    // never "somebody else has it".
    yours: standing?.yours ?? null,
    url: siteUrl(ctx.config.zone, name, ctx.port),
    unchanged: false,
    document,
  };
}
