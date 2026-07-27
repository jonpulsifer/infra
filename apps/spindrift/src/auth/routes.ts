/**
 * The authentication surface outside the product command registry (Task 37).
 *
 * `src/web/routes.ts` states the rule this file has to satisfy: *"A second
 * hand-authored route is a decision somebody has to make on purpose, in this
 * file, against a test that names it."* This is that decision, made once and
 * for two related reasons. §21 makes the dispatch surface
 * **session-authenticated only**, so a command cannot enrol the operator when
 * `CommandContext` requires the `Principal` enrolment creates. Credential
 * administration changes how that Principal is proved, not a product resource,
 * and is rooted in a fresh passkey assertion rather than ordinary command
 * authorization.
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
 * The pre-session members are the only acts in the application reachable
 * without a principal. Credential-administration members authenticate again at
 * this boundary, and `test/web/routes.test.ts` protects the closed route set.
 */
import { z } from 'zod';
import type { Principal } from '../commands/types.ts';
import {
  beginAddPasskey,
  beginCredentialChange,
  type CredentialAdminDeps,
  completeAddPasskey,
  credentialSettings,
  linkGatewayIdentity,
  removePasskey,
  unlinkGatewayIdentity,
} from './credential-admin.ts';
import {
  beginEnrolment,
  completeEnrolment,
  type EnrolmentDeps,
} from './enrol.ts';
import {
  authenticateRequest,
  type GatewayDeps,
  readSessionState,
} from './gateway.ts';
import {
  beginSignIn,
  completeSignIn,
  endSession,
  type OpenedSession,
  sessionCookie,
} from './session.ts';
import { type AuthFailureCode, type AuthResult, authOk } from './types.ts';

/** Unversioned, and named so nobody has to be told it is not an API. */
export const AUTH_PATH_PREFIX = '/internal/auth';

/**
 * Every act on this surface.
 *
 * A tuple rather than a set of function declarations, so the route table is
 * `Object.fromEntries` over it and there is nowhere to write another path
 * without another member here.
 */
export const AUTH_ACTS = [
  'enrol/begin',
  'enrol/complete',
  'signin/begin',
  'signin/complete',
  'signout',
  'session',
  'credentials',
  'credentials/verify/begin',
  'passkeys/add/begin',
  'passkeys/add/complete',
  'passkeys/remove',
  'gateway/link',
  'gateway/unlink',
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
  GATEWAY_ASSERTION_MISSING: 401,
  LAST_PASSKEY: 409,
  CREDENTIAL_ALREADY_ENROLLED: 409,
  UNAUTHENTICATED: 401,
  GATEWAY_IDENTITY_UNLINKED: 403,
  MALFORMED_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  INVALID_INPUT: 422,
} as const satisfies Record<AuthFailureCode | TransportCode, number>;

type TransportCode =
  | 'MALFORMED_REQUEST'
  | 'METHOD_NOT_ALLOWED'
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'GATEWAY_IDENTITY_UNLINKED';

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
        'set-cookie': sessionCookie(session.token),
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

const assertionInput = signInCompleteInput;

const addPasskeyInput = z
  .object({
    credentialId: z.string().min(1),
    publicKey: z.string().min(1),
    algorithm: z.number().int(),
    authenticatorData: z.string().min(1),
    clientDataJSON: z.string().min(1),
  })
  .strict();

const removePasskeyInput = z
  .object({
    credentialId: z.string().min(1),
    assertion: assertionInput,
  })
  .strict();

/** One route per act, and no way to write another. */
export function authRoutes(
  deps: EnrolmentDeps & CredentialAdminDeps,
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
      const cookie = await endSession(request, deps);
      // Idempotent by construction: there is nothing to report and nothing that
      // could have failed, so signing out twice is signing out.
      return Response.json(
        { ok: true, value: null },
        { status: 200, headers: { 'set-cookie': cookie } },
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
      const state = await readSessionState(request, deps);
      return Response.json(
        {
          ok: true,
          value: state,
        },
        { status: 200 },
      );
    },

    credentials: async (request) => {
      if (request.method !== 'GET') {
        return refuse('METHOD_NOT_ALLOWED', 'reading credentials is a GET');
      }
      return withPrincipal(request, deps, async (principal) =>
        Response.json(
          { ok: true, value: await credentialSettings(deps, principal) },
          { status: 200 },
        ),
      );
    },

    'credentials/verify/begin': (request) =>
      authenticatedPost(
        request,
        deps,
        z.object({}).strict(),
        (_input, principal) =>
          beginCredentialChange(deps, principal).then(authOk),
      ),

    'passkeys/add/begin': (request) =>
      authenticatedPost(request, deps, assertionInput, (input, principal) =>
        beginAddPasskey(deps, principal, input),
      ),

    'passkeys/add/complete': (request) =>
      authenticatedPost(request, deps, addPasskeyInput, (input, principal) =>
        completeAddPasskey(deps, principal, input),
      ),

    'passkeys/remove': (request) =>
      authenticatedPost(request, deps, removePasskeyInput, (input, principal) =>
        removePasskey(deps, principal, input),
      ),

    'gateway/link': (request) =>
      authenticatedPost(request, deps, assertionInput, (input, principal) =>
        linkGatewayIdentity(deps, principal, request, input),
      ),

    'gateway/unlink': (request) =>
      authenticatedPost(request, deps, assertionInput, (input, principal) =>
        unlinkGatewayIdentity(deps, principal, input),
      ),
  };

  return Object.fromEntries(
    AUTH_ACTS.map((act) => [authPathFor(act), handlers[act]]),
  );
}

async function withPrincipal(
  request: Request,
  deps: GatewayDeps,
  run: (principal: Principal) => Promise<Response>,
): Promise<Response> {
  const authentication = await authenticateRequest(request, deps);
  if (authentication.kind === 'anonymous') {
    return refuse(
      'UNAUTHENTICATED',
      'credential settings require an authenticated operator',
    );
  }
  if (authentication.kind === 'forbidden') {
    return refuse('GATEWAY_IDENTITY_UNLINKED', authentication.message);
  }
  return run(authentication.principal);
}

async function authenticatedPost<Schema extends z.ZodType>(
  request: Request,
  deps: GatewayDeps,
  schema: Schema,
  run: (
    input: z.infer<Schema>,
    principal: Principal,
  ) => Promise<AuthResult<unknown>>,
): Promise<Response> {
  return withPrincipal(request, deps, (principal) =>
    post(request, schema, (input) => run(input, principal)),
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
