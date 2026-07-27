/**
 * The one surface that cannot be a command (Task 37).
 *
 * `src/web/routes.ts` states the rule this file has to satisfy: *"A second
 * hand-authored route is a decision somebody has to make on purpose, in this
 * file, against a test that names it."* This is that decision, made once and
 * for a reason that is not a preference — §21 makes the dispatch surface
 * **session-authenticated only**, and these are the acts that produce a
 * session. A command cannot enrol the operator, because a `CommandContext`
 * requires the `Principal` enrolment is what creates.
 *
 * So the same discipline is applied a second time rather than abandoned:
 *
 * 1. **Generated from a closed tuple**, not hand-written one at a time. Adding
 *    a route means adding a member of {@link AUTH_ACTS}, and the handler map is
 *    exhaustive over it at compile time.
 * 2. **Explicitly unversioned and internal**, sharing the prefix style of the
 *    command surface. §21 permits purpose-specific integration protocols for
 *    the browser; this is one.
 * 3. **No domain logic.** Every handler decodes JSON, calls one function in
 *    `src/auth/`, and turns the result into a status code. The decisions all
 *    happen below.
 *
 * These are the only routes in the application reachable without a session, and
 * that is the property the count in `test/web/routes.test.ts` protects.
 */
import { z } from 'zod';
import {
  beginEnrolment,
  completeEnrolment,
  type EnrolmentDeps,
} from './enrol.ts';
import {
  beginSignIn,
  clearedSessionCookie,
  closeSession,
  completeSignIn,
  isClaimed,
  type OpenedSession,
  resolveSession,
  sessionCookie,
} from './session.ts';
import type { AuthFailureCode, AuthResult } from './types.ts';

/** Unversioned, and named so nobody has to be told it is not an API. */
export const AUTH_PATH_PREFIX = '/internal/auth';

/**
 * Every act on this surface.
 *
 * A tuple rather than a set of function declarations, so the route table is
 * `Object.fromEntries` over it and there is nowhere to write a sixth path
 * without a sixth member here.
 */
export const AUTH_ACTS = [
  'enrol/begin',
  'enrol/complete',
  'signin/begin',
  'signin/complete',
  'signout',
  'session',
] as const;

export type AuthAct = (typeof AUTH_ACTS)[number];

export function authPathFor(act: AuthAct): string {
  return `${AUTH_PATH_PREFIX}/${act}`;
}

/**
 * The HTTP status a refusal reads as. Total over the closed set, so a new code
 * makes somebody decide what it means over HTTP.
 */
const STATUS = {
  // 401 rather than 403: the caller has not proved who they are, and the token
  // is exactly the proof being asked for.
  TOKEN_INVALID: 401,
  // 409, not 401: the token may well be right. What is being said is a fact
  // about the world — this installation is already claimed — which is the
  // disabled-with-reasons grammar §3 uses everywhere.
  TOKEN_SPENT: 409,
  CHALLENGE_UNKNOWN: 400,
  CEREMONY_REFUSED: 401,
  CREDENTIAL_UNKNOWN: 401,
  NOT_ENROLLED: 409,
  MALFORMED_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  INVALID_INPUT: 422,
} as const satisfies Record<AuthFailureCode | TransportCode, number>;

type TransportCode =
  | 'MALFORMED_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'INVALID_INPUT';

function refuse(
  code: AuthFailureCode | TransportCode,
  message: string,
): Response {
  return Response.json(
    { ok: false, failure: { code, message } },
    { status: STATUS[code] },
  );
}

/** Turn an auth result into a response, minting the cookie on the way out. */
function answer<Value>(
  result: AuthResult<Value>,
  cookieFrom?: (value: Value) => OpenedSession,
): Response {
  if (!result.ok) {
    return Response.json(result, { status: STATUS[result.failure.code] });
  }

  if (cookieFrom === undefined) {
    return Response.json(result, { status: 200 });
  }

  const session = cookieFrom(result.value);
  // The token goes in the cookie and **not** in the body: a value the client's
  // script can read is a value an injected script can read, and `HttpOnly` is
  // the whole point of the cookie carrying it.
  return Response.json(
    { ok: true, value: { principal: session.principal } },
    {
      status: 200,
      headers: {
        'set-cookie': sessionCookie(session.token, session.expiresAt),
      },
    },
  );
}

const enrolBeginInput = z.object({ token: z.string().min(1) }).strict();

const enrolCompleteInput = z
  .object({
    token: z.string().min(1),
    credentialId: z.string().min(1),
    publicKey: z.string().min(1),
    algorithm: z.number().int(),
    authenticatorData: z.string().min(1),
    clientDataJSON: z.string().min(1),
  })
  .strict();

const signInCompleteInput = z
  .object({
    credentialId: z.string().min(1),
    authenticatorData: z.string().min(1),
    clientDataJSON: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();

/** One route per act, and no way to write another. */
export function authRoutes(
  deps: EnrolmentDeps,
): Record<string, (request: Request) => Promise<Response>> {
  const handlers: Record<AuthAct, (request: Request) => Promise<Response>> = {
    'enrol/begin': (request) =>
      post(request, enrolBeginInput, (input) => beginEnrolment(deps, input)),

    'enrol/complete': (request) =>
      post(request, enrolCompleteInput, async (input) =>
        answered(await completeEnrolment(deps, input)),
      ),

    'signin/begin': (request) =>
      post(request, z.object({}).strict(), () => beginSignIn(deps)),

    'signin/complete': (request) =>
      post(request, signInCompleteInput, async (input) =>
        answered(await completeSignIn(deps, input)),
      ),

    signout: async (request) => {
      if (request.method !== 'POST') {
        return refuse('METHOD_NOT_ALLOWED', 'signing out is a POST');
      }
      await closeSession(request, deps);
      // Idempotent by construction: there is nothing to report and nothing that
      // could have failed, so signing out twice is signing out.
      return Response.json(
        { ok: true, value: null },
        { status: 200, headers: { 'set-cookie': clearedSessionCookie() } },
      );
    },

    /**
     * Who the browser is, and whether this installation has been claimed — the
     * two facts the shell needs to decide which screen to render.
     *
     * `claimed` travels with the principal rather than on a route of its own
     * because the client asks both questions at exactly the same moment, and a
     * second round trip would put a flash of the wrong screen between them.
     *
     * A GET, and the only one on this surface: it is a read of the caller's own
     * request, it changes nothing, and making it a POST would say it was an act.
     */
    session: async (request) => {
      if (request.method !== 'GET') {
        return refuse('METHOD_NOT_ALLOWED', 'reading the session is a GET');
      }
      const principal = await resolveSession(request, deps);
      return Response.json(
        { ok: true, value: { principal, claimed: await isClaimed(deps) } },
        { status: 200 },
      );
    },
  };

  return Object.fromEntries(
    AUTH_ACTS.map((act) => [authPathFor(act), handlers[act]]),
  );
}

/** A result that already carries a session, so the cookie is minted from it. */
function answered(result: AuthResult<OpenedSession>): Response {
  return answer(result, (session) => session);
}

/**
 * Decode, validate, run. The whole of what a handler on this surface may do.
 */
async function post<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  run: (input: z.infer<Schema>) => Promise<AuthResult<unknown> | Response>,
): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse('METHOD_NOT_ALLOWED', 'this is dispatched with POST');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return refuse('MALFORMED_REQUEST', 'the request body is not JSON');
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return refuse('INVALID_INPUT', 'that is not a well-formed request');
  }

  const result = await run(parsed.data);
  return result instanceof Response ? result : answer(result);
}
