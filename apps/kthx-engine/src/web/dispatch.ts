/**
 * The browser's command transport, unversioned and internal. Callers present a
 * browser session or a trusted Gateway header; no bearer token is read here.
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
  authenticate(request: Request): Promise<RequestAuthentication>;
  /**
   * Assembled per request, so a command reads the manifest that
   * `configureInstallation` last wrote.
   */
  context(principal: Principal): CommandContext | Promise<CommandContext>;
}

// Total, so a new code must be given a status where it is added.
const STATUS = {
  UNKNOWN_COMMAND: 404,
  INVALID_INPUT: 422,
  NOT_FOUND: 404,
  // 409: the request is well formed, and the state of the world refuses it.
  NOT_DEPLOYABLE: 409,
  NOT_BUILDABLE: 409,
  NOT_RUNNABLE: 409,
  NOT_RESTARTABLE: 409,
  NOT_REMOVABLE: 409,
  STALE_EDIT: 409,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  METHOD_NOT_ALLOWED: 405,
  MALFORMED_REQUEST: 400,
  INTERNAL: 500,
} as const satisfies Record<TransportFailureCode, number>;

/** The envelope a command refuses in, so the client reads one result shape. */
function refuse(code: TransportFailureCode, message: string): Response {
  return Response.json(
    { ok: false, failure: { code, message } },
    {
      status: STATUS[code],
    },
  );
}

/** Built from `commandNames` alone, so no route exists without a command. */
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
    // A GET would make a command link-followable, prefetchable and cacheable.
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
