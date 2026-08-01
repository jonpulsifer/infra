/**
 * The browser command boundary (Task 36b).
 *
 * §21 declines to declare an external API, and a React client still needs
 * somewhere to call. The plan settles that tension by making the boundary
 * **generated**: the route table below is `Object.fromEntries` over
 * `commandNames`, so there is nowhere to write a route that is not a command,
 * and a command added without one is a compile error in `registry.ts` before it
 * is a missing route here.
 *
 * That is the whole mitigation for the risk the plan names — "watch for the
 * first hand-authored route; that is the drift". Three properties hold it:
 *
 * 1. **Generated, not authored.** Adding a path here means adding a command.
 * 2. **Explicitly unversioned and internal**, the same status as the webhook
 *    and build callbacks. The prefix says so. No stability promise, no docs
 *    page, and nothing outside this repo may depend on it.
 * 3. **Session-authenticated only, never a token.** A token is what turns an
 *    internal protocol into an API somebody scripts against, so there is no
 *    code path here that reads one — {@link DispatchDeps.authenticate} returns
 *    a principal or a typed refusal.
 *
 * There is no domain logic in this file, and §21 requires that there be none.
 * What is left is transport: decode JSON, find a principal, call `dispatch`,
 * and choose a status code. Every decision about the act itself was already
 * made by the command.
 *
 * `pathFor`, `COMMAND_PATH_PREFIX`, and `TransportFailureCode` live in
 * `./command-path.ts` and are re-exported below rather than defined here,
 * because those three are the only edge `client.ts` needs into this file —
 * everything else pulls in `commands/registry.ts` as a value, which drags the
 * whole server-only command layer into the browser bundle.
 * `test/web/client-bundle.test.ts` guards against that edge coming back.
 */

import type { RequestAuthentication } from '../auth/types.ts';
import {
  type CommandName,
  commandNames,
  dispatch,
} from '../commands/registry.ts';
import type { CommandContext, Principal } from '../commands/types.ts';
import {
  COMMAND_PATH_PREFIX,
  pathFor,
  type TransportFailureCode,
} from './command-path.ts';

export type { TransportFailureCode };
export { COMMAND_PATH_PREFIX, pathFor };

export interface DispatchDeps {
  /**
   * Who is calling, or `null` for nobody.
   *
   * Auth is a parameter rather than an import because Task 37 owns passkey
   * enrolment and sessions, and this boundary must be complete and testable
   * before it lands. An installation that passes a resolver returning `null`
   * gets a surface that rejects everything — which is the correct behaviour for
   * a boundary whose authentication is not built yet, and is the reason this is
   * not a stub that returns a fake principal.
   */
  authenticate(request: Request): Promise<RequestAuthentication>;
  /**
   * Everything a command may reach, assembled per request (§21).
   *
   * Asynchronous because configuration is the UI's to drive: a command that
   * reads `context.manifest` has to see what `configureInstallation` last
   * wrote, and the row is the only place that is known. A process-lifetime
   * copy would have made every configuration change require a restart — the
   * declared-change-that-does-nothing failure §20's authoring path exists to
   * remove.
   */
  context(principal: Principal): CommandContext | Promise<CommandContext>;
}

/**
 * The HTTP status a refusal reads as.
 *
 * Deliberately a total map rather than a default with a fallback: a new code
 * should make somebody decide what it means over HTTP, and `satisfies` is what
 * forces that at the point the code is added.
 */
const STATUS = {
  UNKNOWN_COMMAND: 404,
  INVALID_INPUT: 422,
  NOT_FOUND: 404,
  // 409, not 422: the request is well formed and the caller has nothing to fix
  // in it. What they are being told is a fact about the world — this Build has
  // no artifact, this Target takes a different shape — which is the
  // disabled-with-reasons grammar §3 uses everywhere, and a conflict is the
  // status that means "not in this state".
  NOT_DEPLOYABLE: 409,
  NOT_BUILDABLE: 409,
  STALE_EDIT: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  METHOD_NOT_ALLOWED: 405,
  MALFORMED_REQUEST: 400,
  INTERNAL: 500,
} as const satisfies Record<TransportFailureCode, number>;

/**
 * Refuse in the same envelope a command refuses in.
 *
 * The browser has one shape to read whether the refusal came from a schema or
 * from this file, which is the property that lets `client.ts` return one result
 * type instead of branching on where the answer was decided.
 */
function refuse(code: TransportFailureCode, message: string): Response {
  return Response.json(
    { ok: false, failure: { code, message } },
    {
      status: STATUS[code],
    },
  );
}

/**
 * One route per command, and no way to write another.
 *
 * The return value is handed straight to `Bun.serve`'s `routes` option. It is
 * built from `commandNames` and nothing else, so the set of reachable paths and
 * the set of commands are the same set by construction rather than by review.
 */
export function commandRoutes(
  deps: DispatchDeps,
): Record<string, (request: Request) => Promise<Response>> {
  return Object.fromEntries(
    commandNames.map((name) => [
      pathFor(name),
      async (request: Request) => handle(name, request, deps),
    ]),
  );
}

async function handle(
  name: CommandName,
  request: Request,
  deps: DispatchDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    // A command is an act. Making one reachable by GET would make it
    // link-followable, pre-fetchable, and cacheable — three ways to run it
    // without anybody asking.
    return refuse('METHOD_NOT_ALLOWED', 'a command is dispatched with POST');
  }

  const authentication = await deps.authenticate(request);
  if (authentication.kind === 'anonymous') {
    return refuse(
      'UNAUTHENTICATED',
      'this surface is reachable only with a session',
    );
  }
  if (authentication.kind === 'forbidden') {
    return refuse('FORBIDDEN', authentication.message);
  }
  const { principal } = authentication;

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return refuse('MALFORMED_REQUEST', 'the request body is not JSON');
  }

  try {
    const result = await dispatch(name, input, await deps.context(principal));
    return result.ok
      ? Response.json(result, { status: 200 })
      : Response.json(result, { status: STATUS[result.failure.code] });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return refuse('INTERNAL', message);
  }
}
