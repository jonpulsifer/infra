/**
 * A window event every transport raises when its session is gone, so the
 * shell's sign-in gate needs no callback threaded through the tree.
 */

export const SESSION_EXPIRED_EVENT = 'spindrift:session-expired';

/** Call on an `UNAUTHENTICATED` response. */
export function reportSessionExpired(): void {
  dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
