/**
 * Whether any realtime stream is reconnecting, as a store for
 * `useSyncExternalStore`. A set of per-stream symbols, since a socket can close
 * twice while retrying and a counter would overcount.
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

/** The stream connected again or gave up. */
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
