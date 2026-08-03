/**
 * The client-safe edge of the auth boundary (Task 37).
 *
 * `.agent/plans/spindrift/issues/34-keep-the-server-out-of-the-browser-bundle.md`
 * names this as edge 3, found while verifying edge 2: `auth-client.ts`
 * value-imported `AUTH_PATH_PREFIX` and `AuthAct` from `src/auth/routes.ts`,
 * which value-imports `session.ts`, which value-imports `credentials`,
 * `sessions`, and `users` from `db/schema.ts`. `db/schema.ts` is one module
 * declaring every table, so any live edge into it — regardless of which table
 * the importer actually wanted — drags the whole file and the whole
 * `drizzle-orm` surface into the browser bundle. That is why cutting edge 2
 * (the streaming transport) left the bundle's `drizzle-orm` count unchanged:
 * this edge was still open.
 *
 * `AUTH_PATH_PREFIX`, `AUTH_ACTS`, `AuthAct`, and `authPathFor` are the only
 * things `auth-client.ts` needs from `src/auth/routes.ts`, and none of them
 * touch the database — they are a route prefix, a closed tuple of act names,
 * and a function that concatenates the two. So, the same move as
 * `command-path.ts` (edge 1) and `stream-path.ts` (edge 2): they live here,
 * in a leaf module with no imports of their own, and `routes.ts` re-exports
 * them rather than defining them, so the server side is unchanged and there
 * is exactly one definition of each. `test/web/client-bundle.test.ts` builds
 * the client and asserts `db/schema.ts` and `drizzle-orm` are unreachable.
 */

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
