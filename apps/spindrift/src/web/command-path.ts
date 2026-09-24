/**
 * The command route and refusal codes the browser needs, kept out of
 * `dispatch.ts`, which re-exports them. The registry arrives by `import type`
 * only, so the command layer never enters the browser bundle.
 */
import type { CommandName } from '../commands/registry.ts';
import type { CommandFailureCode } from '../commands/types.ts';

/** Unversioned, and named internal because it is no public API. */
export const COMMAND_PATH_PREFIX = '/internal/commands';

/** Takes a {@link CommandName}, so every path names a real command. */
export function pathFor(name: CommandName): string {
  return `${COMMAND_PATH_PREFIX}/${name}`;
}

/**
 * The command layer's codes plus those only the transport produces. One union
 * keeps `STATUS` in `dispatch.ts` total.
 */
export type TransportFailureCode =
  | CommandFailureCode
  | 'UNAUTHENTICATED'
  | 'METHOD_NOT_ALLOWED'
  | 'MALFORMED_REQUEST'
  | 'INTERNAL';
