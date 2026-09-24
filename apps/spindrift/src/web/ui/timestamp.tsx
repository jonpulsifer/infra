/**
 * A relative time recomputed in the browser from the ISO instant, on one shared
 * 30-second tick. A server render keeps the server's own `when` phrase.
 */
import { useSyncExternalStore } from 'react';
import { elapsedSince } from '../../domain/elapsed.ts';

const TICK_MS = 30_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();
      for (const each of listeners) each();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0 || timer === null) return;
    clearInterval(timer);
    timer = null;
  };
}

/**
 * Cached: `useSyncExternalStore` treats a changed snapshot as a torn read, so
 * reading `Date.now()` here would re-render forever.
 */
function browserNow(): number | null {
  return now;
}

/** No browser clock, so the server's phrase stands. */
function serverNow(): number | null {
  return null;
}

export function Timestamp({
  at,
  when,
  className,
}: {
  readonly at: string;
  readonly when?: string;
  readonly className?: string;
}) {
  const clock = useSyncExternalStore(subscribe, browserNow, serverNow);
  const parsed = Date.parse(at);

  // No instant: show the phrase if there is one, and otherwise nothing.
  if (Number.isNaN(parsed)) {
    return when ? <span className={className}>{when}</span> : null;
  }

  const instant = new Date(parsed);
  const label =
    clock === null
      ? (when ?? instant.toISOString())
      : elapsedSince(instant, new Date(clock));

  return (
    <time
      dateTime={instant.toISOString()}
      title={instant.toISOString()}
      className={className}
    >
      {label}
    </time>
  );
}
