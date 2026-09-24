/**
 * Auth HTTP routes, outside the command registry because enrolment and sign-in
 * run before a `Principal` exists. Handlers hold no domain logic.
 */
import { z } from 'zod';
import type { Principal } from '../commands/types.ts';
import {
  AUTH_ACTS,
  AUTH_PATH_PREFIX,
  type AuthAct,
  authPathFor,
} from '../web/auth-path.ts';
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

// Defined in web/auth-path.ts so browser code need not import this module.
export type { AuthAct };
export { AUTH_ACTS, AUTH_PATH_PREFIX, authPathFor };

/** Total over every code, so a new code needs an explicit status. */
const STATUS = {
  // 401: the token is the proof of identity being asked for.
  TOKEN_INVALID: 401,
  // 409: the token may be right, but the installation is already claimed.
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
  // The token travels only in the `HttpOnly` cookie, never the body, so no
  // script can read it.
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

/** The handler map is exhaustive over `AuthAct`, so every route is one act. */
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
      return Response.json(
        { ok: true, value: null },
        { status: 200, headers: { 'set-cookie': cookie } },
      );
    },

    // `claimed` rides with the principal so the shell picks its first screen
    // in one round trip, with no flash of the wrong one.
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

function answered(result: AuthResult<OpenedSession>): Response {
  return answer(result, (session) => session);
}

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
