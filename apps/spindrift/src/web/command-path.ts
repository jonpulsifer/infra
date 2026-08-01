/**
 * The client-safe edge of the command dispatch boundary.
 *
 * `dispatch.ts` is the server-side transport, and behind `commands/registry.ts`
 * sits every command handler — drizzle queries, adapter imports, server-only
 * modules. None of that has business in the browser. But the browser still
 * needs to know the route a command is reached at, and the shape of a
 * transport-produced refusal, so those three things — `pathFor`,
 * `COMMAND_PATH_PREFIX`, and `TransportFailureCode` — live in their own module
 * rather than in `dispatch.ts`.
 *
 * The load-bearing line is the import below: `CommandName` comes in with
 * `import type`, which TypeScript erases at compile time, so Bun never turns
 * it into a module edge. That is what keeps the registry — and the entire
 * command layer behind it — out of `client.ts`'s reachable graph.
 * `test/web/client-bundle.test.ts` builds the client and asserts this holds.
 *
 * `dispatch.ts` re-exports from here rather than this module importing from
 * `dispatch.ts`, so the server side is unchanged and there is exactly one
 * definition of each of these three things.
 */
import type { CommandName } from '../commands/registry.ts';
import type { CommandFailureCode } from '../commands/types.ts';

/**
 * Unversioned, and named so that nobody has to be told twice. §21 permits a
 * purpose-specific integration protocol for the browser; this is that and
 * nothing more.
 */
export const COMMAND_PATH_PREFIX = '/internal/commands';

/**
 * The route a command is reached at, and the one place the path is composed.
 *
 * It takes a {@link CommandName} rather than a string on purpose: this file's
 * whole claim is that a path with no command behind it cannot be written, and a
 * `string` parameter here would be the one place somebody could write one.
 */
export function pathFor(name: CommandName): string {
  return `${COMMAND_PATH_PREFIX}/${name}`;
}

/**
 * Why a request was refused before, or instead of, a command running.
 *
 * The command layer's codes plus the two only a transport can produce. Both
 * additions are genuinely not the command layer's business: a request with no
 * session never reaches a command, and neither does one whose body is not JSON,
 * so neither could be a `CommandFailureCode` without inventing a failure the
 * command layer cannot cause.
 *
 * Keeping them in one union is what makes `dispatch.ts`'s `STATUS` total.
 * `client.ts` imports this rather than widening to `string`, so a browser
 * switching on a refusal is switching over a closed set.
 */
export type TransportFailureCode =
  | CommandFailureCode
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'METHOD_NOT_ALLOWED'
  | 'MALFORMED_REQUEST'
  | 'INTERNAL';
