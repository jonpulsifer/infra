/**
 * The `web` process's whole route table, in one testable function.
 *
 * This module exists because of where the drift actually lives. Task 36b's
 * acceptance — "no route exists that is not a registry command" — is trivially
 * true of `commandRoutes`, which is generated and could not fail it. The place a
 * hand-authored route would appear is the table that *spreads* it, and that used
 * to be inline in `server.ts` next to a top-level `Bun.serve` no test can
 * import. So the table moved here and the entries call it.
 *
 * Three kinds of route exist, and two of the three are generated:
 *
 * 1. **Commands**, from the registry (`dispatch.ts`).
 * 2. **The client**, from whatever built it — `bundle.ts` reading a directory in
 *    production, Bun's HTML import in development. Both are generated; neither
 *    is a path anybody typed.
 * 3. **{@link HEALTH_PATH}**, and that is the whole of the hand-authored
 *    surface. One route, holding no domain logic, answering the same two bytes
 *    forever.
 *
 * A second hand-authored route is a decision somebody has to make on purpose,
 * in this file, against a test that names it.
 */
import { commandRoutes, type DispatchDeps } from './dispatch.ts';

/**
 * The one route that is neither a command nor part of the client bundle.
 *
 * It is a constant rather than a handler on purpose: a probe that can consult
 * something is a probe that can be wrong about something, and §21's "no route
 * may contain domain logic" is easiest to keep when there is no logic to keep
 * out.
 */
export const HEALTH_PATH = '/healthz';

/**
 * What a client route may be: a built file's `Response` in production, or Bun's
 * `HTMLBundle` in development. Narrow on purpose — a *handler* here would be a
 * place to put logic, and the client half of this table is meant to be inert.
 */
export type ClientRoute = Response | Bun.HTMLBundle;

/**
 * Assemble the table `Bun.serve` is given.
 *
 * The client's routes are a parameter rather than an import because the two
 * entries build them differently — and the difference is the whole point of the
 * split. `server.ts` reads a directory that was built into the image;
 * `dev.ts` imports the HTML and lets Bun compile it on the fly. Passing them in
 * also keeps this function callable from a test, which importing either would
 * not.
 */
export function webRoutes<Client extends Record<string, ClientRoute>>(
  client: Client,
  deps: DispatchDeps,
) {
  return {
    ...client,
    '/healthz': new Response('ok\n'),
    ...commandRoutes(deps),
  };
}
