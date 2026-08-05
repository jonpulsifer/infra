/**
 * Whether any realtime stream this browser opened is between connections right
 * now — read the same way `router.ts` reads the hash: an external store,
 * subscribed to with `useSyncExternalStore` rather than an effect, because a
 * socket can drop between render and commit the same way the hash can change
 * mid-transition.
 *
 * Membership in a `Set` rather than a counter. A socket can close more than
 * once before its next successful message — the network dropping twice in a
 * row while `stream-client.ts` backs off is the ordinary case, not an edge
 * case — and a counter incremented on every close would drift above the
 * number of streams actually retrying. Each subscription owns one `symbol` for
 * its lifetime, so marking it twice or once reads the same.
 */

const reconnecting = new Set<symbol>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** A stream this browser opened is retrying a dropped connection. */
export function markReconnecting(id: symbol): void {
  if (reconnecting.has(id)) return;
  reconnecting.add(id);
  notify();
}

/** That stream connected again, or gave up — either way it is done retrying. */
export function markSettled(id: symbol): void {
  if (!reconnecting.delete(id)) return;
  notify();
}

export function isReconnecting(): boolean {
  return reconnecting.size > 0;
}

export function onConnectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
