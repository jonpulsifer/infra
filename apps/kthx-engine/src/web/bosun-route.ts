/**
 * The routes a bosun host polls, since this process cannot dial it: claim a
 * build, heartbeat the claim, report the result. A shared bearer secret stands
 * in for a browser session; with none configured, every call is refused.
 */
import { z } from 'zod';
import { deadlineFrom, type Sleeper } from '../adapters/build/route.ts';
import type { Clock } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { recordClaimPoll } from '../storage/bosun-poll.ts';
import { buildOutbox } from '../storage/build-outbox.ts';
import { bosunUnfencedCalls } from '../telemetry/index.ts';

export const BOSUN_CLAIM_PATH = '/internal/bosun/claim';
export const BOSUN_HEARTBEAT_PATH = '/internal/bosun/requests/:id/heartbeat';
export const BOSUN_RESULT_PATH = '/internal/bosun/requests/:id/result';

export const BOSUN_PATHS = [
  BOSUN_CLAIM_PATH,
  BOSUN_HEARTBEAT_PATH,
  BOSUN_RESULT_PATH,
] as const;

/** An installation Secret key read at boot, never from the manifest. */
export const BOSUN_SECRET_VAR = 'SPINDRIFT_BOSUN_SECRET';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
// A claim with nothing to hand out holds the connection this long, then answers
// 204 so the host asks again.
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
 * A query parameter, because the result body is strict and a heartbeat has
 * none. Absent or empty means the host did not ask to be fenced.
 */
function claimantFromQuery(url: URL, call: string): string | undefined {
  const claimant = url.searchParams.get('claimant')?.trim() || undefined;
  if (claimant === undefined) bosunUnfencedCalls.add(1, { call });
  return claimant;
}

/**
 * Parsed from the URL: Bun fills `.params` only on a request its router
 * matched, and tests call these handlers directly.
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
  // Any authenticated poll marks the host live, whether or not it finds work.
  recordClaimPoll(deps.clock.now());

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
    // Expired leases come back on each pass, the only time a free lease matters.
    await outbox.reclaimExpired();
    const claimed = await outbox.claim(parsed.data.classes);
    if (claimed !== null) {
      return Response.json({
        id: claimed.id,
        class: claimed.class,
        request: claimed.request,
        claimant: claimed.claimant,
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

  const url = new URL(request.url);
  const id = idFromPath(url.pathname);
  if (id === null) return refuse(400, 'BODY_MALFORMED', 'missing request id');
  const outbox = buildOutbox(deps.db, deps.clock.now);
  const extended = await outbox.heartbeat(
    id,
    claimantFromQuery(url, 'heartbeat'),
  );
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

  const url = new URL(request.url);
  const id = idFromPath(url.pathname);
  if (id === null) return refuse(400, 'BODY_MALFORMED', 'missing request id');
  const outbox = buildOutbox(deps.db, deps.clock.now);
  const outcome = await outbox.complete(
    id,
    parsed.data,
    claimantFromQuery(url, 'result'),
  );
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
