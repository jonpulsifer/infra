/**
 * The auth route names, in a leaf module with no imports so the browser bundle
 * never reaches the database schema. `src/auth/routes.ts` re-exports them.
 */

/** Unversioned, and named internal because it is no public API. */
export const AUTH_PATH_PREFIX = '/internal/auth';

/** The server builds its route table from this tuple, one path per member. */
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
