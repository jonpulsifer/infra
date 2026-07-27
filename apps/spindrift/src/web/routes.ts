/**
 * The `web` process's whole route table, in one testable function.
 *
 * This module exists because of where the drift actually lives. Task 36b's
 * acceptance — "no route exists that is not a registry command" — is trivially
 * true of `commandRoutes`, which is generated and could not fail it. The place
 * a hand-authored route would appear is the table that *spreads* it, and that
 * used to be inline in `server.ts` next to a top-level `Bun.serve` no test can
 * import. So the table moved here and `server.ts` calls it.
 *
 * {@link NON_COMMAND_ROUTES} is the closed list of paths that are allowed to
 * exist without a command behind them, and it is deliberately short. Neither
 * entry holds domain logic, which is the actual §21 rule: one is the document
 * the client mounts into, the other is a liveness probe that answers the same
 * two bytes forever. A third entry is a decision somebody has to make on
 * purpose, in this file, against a test that names it.
 */
import { commandRoutes, type DispatchDeps } from './dispatch.ts';

/**
 * Every route that is not a command, and the reason it is allowed to be one.
 *
 * Adding to this list is how the surface §21 declined to declare would actually
 * grow — not through `commandRoutes`, which cannot grow one. `test/web/routes.
 * test.ts` asserts the served table contains these and command paths, and
 * nothing else.
 */
export const NON_COMMAND_ROUTES = {
  /** The one HTML entry. The client owns navigation; the server serves it once. */
  '/': 'the client document',
  /** A liveness probe. Constant, and reaches nothing. */
  '/healthz': 'a liveness probe',
} as const;

export type NonCommandRoute = keyof typeof NON_COMMAND_ROUTES;

/**
 * Assemble the table `Bun.serve` is given.
 *
 * `index` is a parameter rather than an import because Bun's HTML import is a
 * bundler feature: importing it pulls the client build into whatever loads this
 * module, which a test has no use for. Passing it keeps this function callable
 * from one.
 */
export function webRoutes<Index>(index: Index, deps: DispatchDeps) {
  return {
    '/': index,
    '/healthz': new Response('ok\n'),
    ...commandRoutes(deps),
  };
}
