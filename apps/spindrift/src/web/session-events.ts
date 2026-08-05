/**
 * The one signal every transport raises when the session it trusted turns out
 * to be gone.
 *
 * Dispatch (`client.ts`), the archive upload (`views/apps/new/index.tsx`), and
 * the stream reconnect loop (`stream-client.ts`) are three different
 * transports reachable from anywhere in the tree, and none of them owns the
 * shell's gate — `App` in `app.tsx` does. Threading a callback down to every
 * caller of `command()`, every upload row, and every stream subscription would
 * make the gate a prop the whole tree carries for one rare event. This is the
 * seam they call back through instead: the same `dispatchEvent`/
 * `addEventListener` idiom `router.ts` already uses for the hash, because
 * `window` is a channel every one of these already runs on.
 */

export const SESSION_EXPIRED_EVENT = 'spindrift:session-expired';

/** A transport just read `UNAUTHENTICATED` off an otherwise-ordinary response. */
export function reportSessionExpired(): void {
  dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
