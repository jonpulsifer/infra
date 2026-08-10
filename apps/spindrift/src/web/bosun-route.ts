/**
 * The bosun poll surface, mounted (Task: bosun build route).
 *
 * `src/adapters/build/bosun.ts` writes an intent into the outbox and never
 * calls out again — bosun's warm-pool daemon is on a host this process
 * cannot dial, so the only way to hand it work is to let it come and ask.
 * These three routes are what it asks: claim something to build, keep a
 * claim alive, and report what happened. `src/storage/build-outbox.ts` is
 * the store underneath all three; nothing here holds outbox state of its
 * own.
 *
 * **A deliberate exception to `dispatch.ts`'s "session-authenticated only,
 * never a token."** That rule exists because a token is what turns an
 * internal protocol into an API somebody scripts against — but a bosun host
 * cannot present a browser session, the same reason `webhook-route.ts` is
 * the other named exception. It follows that route's posture exactly: the
 * shared secret arrives as an installation Secret key
 * ({@link BOSUN_SECRET_VAR}), read once at boot, and its absence refuses
 * every request before anything below runs — an installation nobody has
 * configured a secret for has nothing here for a poller to prove.
 *
 * **The claim endpoint long-polls.** A bosun host would otherwise have to
 * busy-loop `POST`ing every second to notice new work; instead this route
 * holds the connection, re-checking on a short interval, and answers `204`
 * once its own budget runs out so the host can immediately ask again. The
 * pacing is injectable for the same reason every build route's own polling
 * is (`adapters/build/route.ts`'s `Deadline`, reused here rather than
 * reimplemented): a test that actually waited out a 25-second window would
 * be a test nobody could run twice in a row.
 */
import { z } from 'zod';
import { deadlineFrom, type Sleeper } from '../adapters/build/route.ts';
import type { Clock } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { buildOutbox } from '../storage/build-outbox.ts';

export const BOSUN_CLAIM_PATH = '/internal/bosun/claim';
export const BOSUN_HEARTBEAT_PATH = '/internal/bosun/requests/:id/heartbeat';
export const BOSUN_RESULT_PATH = '/internal/bosun/requests/:id/result';

/** Every route this file mounts, for `routes.ts`'s table. */
export const BOSUN_PATHS = [
  BOSUN_CLAIM_PATH,
  BOSUN_HEARTBEAT_PATH,
  BOSUN_RESULT_PATH,
] as const;

/**
 * Where the shared secret arrives — mirrors `webhook-route.ts`'s
 * `WEBHOOK_SECRET_VAR`: an installation Secret key, read once at boot, never
 * from the manifest an operator authors and hands around.
 */
export const BOSUN_SECRET_VAR = 'SPINDRIFT_BOSUN_SECRET';

/** How long the claim endpoint holds a connection open with nothing to hand out. */
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;

/** A result's log, capped so one runaway build cannot fill the outbox table. */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const claimBodySchema = z
  .object({
    classes: z.array(z.string().trim().min(1)).min(1),
  })
  .strict();

const resultBodySchema = z
  .object({
    status: z.enum(['SUCCEEDED', 'FAILED']),
    log: z
      .string()
      .refine((log) => Buffer.byteLength(log, 'utf8') <= MAX_LOG_BYTES, {
        message: `log exceeds ${MAX_LOG_BYTES} bytes`,
      }),
    detail: z.string().optional(),
  })
  .strict();

export interface BosunRouteDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** `null` when this installation has no bosun secret configured. */
  readonly secret: string | null;
  /** Injected so a test's claim long-poll takes no wall-clock time. */
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly sleep?: Sleeper;
}

export function bosunRoutes(
  deps: BosunRouteDeps,
): Record<string, (request: Request) => Promise<Response>> {
  return {
    [BOSUN_CLAIM_PATH]: (request) => handleClaim(request, deps),
    [BOSUN_HEARTBEAT_PATH]: (request) => handleHeartbeat(request, deps),
    [BOSUN_RESULT_PATH]: (request) => handleResult(request, deps),
  };
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, failure: { code, message } }, { status });
}

/**
 * The `:id` segment, read from the URL rather than from Bun's `.params`.
 *
 * Bun's router only populates `.params` on a request it matched itself, which
 * a direct call to a handler — every test in `test/web/bosun-route.test.ts`
 * — never goes through. Parsing the path here instead makes a handler
 * callable identically in production (mounted by `Bun.serve`) and in a unit
 * test (called directly against a manufactured `Request`); the pattern in
 * {@link BOSUN_HEARTBEAT_PATH} and {@link BOSUN_RESULT_PATH} still tells
 * `Bun.serve` which requests reach these handlers at all.
 */
function idFromPath(pathname: string): string | null {
  const match =
    /^\/internal\/bosun\/requests\/([^/]+)\/(?:heartbeat|result)$/.exec(
      pathname,
    );
  return match?.[1] ?? null;
}

/** `null` when the request may proceed; the refusal to answer with otherwise. */
function checkAuth(request: Request, deps: BosunRouteDeps): Response | null {
  if (deps.secret === null) {
    return refuse(
      503,
      'NOT_CONFIGURED',
      `this installation has no ${BOSUN_SECRET_VAR} configured`,
    );
  }
  const header = request.headers.get('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token !== deps.secret) {
    return refuse(401, 'UNAUTHORIZED', 'missing or wrong bearer token');
  }
  return null;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function handleClaim(
  request: Request,
  deps: BosunRouteDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse(405, 'METHOD_NOT_ALLOWED', 'a claim is a POST');
  }
  const denied = checkAuth(request, deps);
  if (denied) return denied;

  const parsed = claimBodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return refuse(400, 'BODY_MALFORMED', parsed.error.message);
  }

  const outbox = buildOutbox(deps.db, deps.clock.now);
  const budget = deadlineFrom({
    intervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    now: deps.clock.now,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  for (;;) {
    // Reclamation runs on every pass, not on a separate timer: a lease that
    // expired between two long-polls is reclaimed the moment anything next
    // asks for work, which is the only time reclaiming it matters.
    await outbox.reclaimExpired();
    const claimed = await outbox.claim(parsed.data.classes);
    if (claimed !== null) {
      return Response.json({
        id: claimed.id,
        class: claimed.class,
        request: claimed.request,
      });
    }
    if (budget.expired()) return new Response(null, { status: 204 });
    await budget.tick();
  }
}

async function handleHeartbeat(
  request: Request,
  deps: BosunRouteDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse(405, 'METHOD_NOT_ALLOWED', 'a heartbeat is a POST');
  }
  const denied = checkAuth(request, deps);
  if (denied) return denied;

  const id = idFromPath(new URL(request.url).pathname);
  if (id === null) return refuse(400, 'BODY_MALFORMED', 'missing request id');
  const outbox = buildOutbox(deps.db, deps.clock.now);
  const extended = await outbox.heartbeat(id);
  return extended
    ? new Response(null, { status: 204 })
    : refuse(404, 'NOT_FOUND', `no claimed build request ${id}`);
}

async function handleResult(
  request: Request,
  deps: BosunRouteDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse(405, 'METHOD_NOT_ALLOWED', 'a result is a POST');
  }
  const denied = checkAuth(request, deps);
  if (denied) return denied;

  const parsed = resultBodySchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return refuse(400, 'BODY_MALFORMED', parsed.error.message);
  }

  const id = idFromPath(new URL(request.url).pathname);
  if (id === null) return refuse(400, 'BODY_MALFORMED', 'missing request id');
  const outbox = buildOutbox(deps.db, deps.clock.now);
  const outcome = await outbox.complete(id, parsed.data);
  switch (outcome) {
    case 'done':
      return new Response(null, { status: 204 });
    case 'missing':
      return refuse(404, 'NOT_FOUND', `no build request ${id}`);
    case 'conflict':
      return refuse(
        409,
        'CONFLICT',
        `build request ${id} already has a result`,
      );
  }
}
