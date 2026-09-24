/**
 * In-process wake-ups for attempt-event stream pumps. An optimization only: the
 * 750ms pump poll in `src/web/streams.ts` converges with every wake-up dropped,
 * and writes from the reconciler process always wait for it.
 */

type Listener = () => void;

// Bun's SQL client has no session-level LISTEN, so NOTIFY cannot replace this.
const listeners = new Map<string, Set<Listener>>();

export function notifyAttemptEvent(componentId: string): void {
  const set = listeners.get(componentId);
  if (set === undefined) return;
  for (const listener of set) {
    try {
      listener();
    } catch {
      // One throwing listener must not stop the rest from waking.
    }
  }
}

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
