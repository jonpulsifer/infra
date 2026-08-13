/**
 * The last authenticated `/internal/bosun/claim` request, in process memory.
 *
 * `src/web/bosun-route.ts` and the command layer both mount inside the one
 * `web` process (`src/web/serve.ts` builds a single route table out of
 * both), so a module-level timestamp is enough to answer "is anything
 * actually polling this pool" without a schema change — `handleClaim` writes
 * it, `src/commands/builds/list-routes.ts` reads it.
 *
 * ponytail: process memory, not a row — a restart clears it, so a pool that
 * has been idle for a week and one that has been idle for ten seconds since
 * the last rollout render identically until the next real poll lands.
 * Upgrade path: a single-row table `build-outbox.ts` could write the same
 * way it already writes `build_requests`, if that blind window ever turns
 * out to matter more than the one field it costs today.
 */
let at: Date | null = null;

/** Called once per authenticated claim request, whether or not it finds work. */
export function recordClaimPoll(now: Date): void {
  at = now;
}

/** `null` until this process has seen one authenticated claim request. */
export function lastClaimPollAt(): Date | null {
  return at;
}
