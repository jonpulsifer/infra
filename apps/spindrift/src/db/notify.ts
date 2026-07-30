/**
 * In-process wake-up for attempt-event poll loops (§6, Transport shape).
 *
 * **Purely an optimization, never the delivery path.** The poll loop in
 * `src/web/streams.ts` converges identically with every notification
 * dropped — this only shortens the sleep, never extends it.
 *
 * When the web process itself writes an attempt event (build callbacks,
 * webhook-triggered builds), the write path fires `notifyAttemptEvent`,
 * which wakes every pump loop subscribed to that component. The
 * reconciler runs in a separate process and its writes arrive on the
 * next poll tick (up to 750ms), which is the same latency this install
 * has when the web process restarts and loses all in-process state.
 *
 * **Why not Postgres `LISTEN`/`NOTIFY`?** Bun's native SQL client
 * (`bun:SQL`) does not yet expose a session-level `LISTEN` API. Adding
 * a `postgres.js` dependency for one notification channel is a bigger
 * change than the latency improvement justifies, and the plan is
 * explicit that NOTIFY is an optimization — one that can land later
 * when the client supports it, without changing the pump logic at all.
 */

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();

/**
 * Wake every pump loop watching events for this component.
 *
 * Called from `src/domain/attempt-log.ts` after each successful insert.
 * Fire-and-forget: a lost notification only delays the next poll.
 */
export function notifyAttemptEvent(componentId: string): void {
  const set = listeners.get(componentId);
  if (set === undefined) return;
  for (const listener of set) {
    try {
      listener();
    } catch {
      // A listener that throws is a listener that is going away.
    }
  }
}

/**
 * Subscribe to in-process wake-ups for one component's attempt events.
 *
 * Returns an unsubscribe function. The caller (the pump loop) calls it
 * when the WebSocket closes.
 */
export function onAttemptEvent(
  componentId: string,
  listener: Listener,
): () => void {
  let set = listeners.get(componentId);
  if (set === undefined) {
    set = new Set();
    listeners.set(componentId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(componentId);
  };
}
