/**
 * The last authenticated bosun claim request this process saw. Module state
 * works because the claim route and the routes list share the `web` process.
 * ponytail: a restart clears it; a single-row table would survive one.
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
