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
 *    code path here that reads one — {@link DispatchDeps.session} returns a
 *    principal or nothing.
 *
 * There is no domain logic in this file, and §21 requires that there be none.
 * What is left is transport: decode JSON, find a principal, call `dispatch`,
 * and choose a status code. Every decision about the act itself was already
 * made by the command.
 */
import { commandNames, dispatch } from '../commands/registry.ts';
import type {
  CommandContext,
  CommandFailureCode,
  Principal,
} from '../commands/types.ts';

/**
 * Unversioned, and named so that nobody has to be told twice. §21 permits a
 * purpose-specific integration protocol for the browser; this is that and
 * nothing more.
 */
export const COMMAND_PATH_PREFIX = '/internal/commands';

/** The route a command is reached at. The one place the path is composed. */
export function pathFor(name: string): string {
  return `${COMMAND_PATH_PREFIX}/${name}`;
}

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
  session(request: Request): Promise<Principal | null>;
  /** Everything a command may reach, assembled per request (§21). */
  context(principal: Principal): CommandContext;
}

/**
 * The HTTP status a refusal reads as.
 *
 * Deliberately a total map over the closed failure set rather than a default:
 * a ninth failure code should make somebody decide what it means over HTTP,
 * and `satisfies` is what forces that.
 */
const STATUS = {
  UNKNOWN_COMMAND: 404,
  INVALID_INPUT: 422,
  NOT_FOUND: 404,
} as const satisfies Record<CommandFailureCode, number>;

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
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
  name: string,
  request: Request,
  deps: DispatchDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    // A command is an act. Making one reachable by GET would make it
    // link-followable, pre-fetchable, and cacheable — three ways to run it
    // without anybody asking.
    return json(
      {
        ok: false,
        failure: {
          code: 'INVALID_INPUT',
          message: 'a command is dispatched with POST',
        },
      },
      405,
    );
  }

  const principal = await deps.session(request);
  if (principal === null) {
    return json(
      {
        ok: false,
        failure: {
          code: 'UNAUTHENTICATED',
          message: 'this surface is reachable only with a session',
        },
      },
      401,
    );
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return json(
      {
        ok: false,
        failure: {
          code: 'INVALID_INPUT',
          message: 'the request body is not JSON',
        },
      },
      400,
    );
  }

  const result = await dispatch(name, input, deps.context(principal));
  return result.ok
    ? json(result, 200)
    : json(result, STATUS[result.failure.code]);
}
