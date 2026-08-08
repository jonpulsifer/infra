/**
 * When something happened, in the words a person uses, kept true as they read.
 *
 * The read models carry two fields for one instant — `at`, the ISO timestamp,
 * and `when`, the relative phrase the *server* computed against its own clock.
 * That split is deliberate and `domain/elapsed.ts` explains why: a relative time
 * computed in the browser is computed against the browser's clock, and a machine
 * whose clock is an hour off would render a release from this minute as "1h ago".
 * The server's phrase is the honest one.
 *
 * It is also frozen at the moment of the response, which is the problem this
 * component exists for: a screen that polls every fifteen seconds shows a
 * `just now` that is four minutes old, and an operator watching a rollout reads
 * a stale word as a stalled deploy. So the phrase is recomputed in the browser
 * *from the ISO instant*, on one shared 30-second tick — one interval for the
 * whole page, not one per row, because a ledger of forty rows should not hold
 * forty timers to move one word each.
 *
 * The tick is an external store rather than a `useState` + `useEffect` for the
 * reason `router.ts` and `connection-status.ts` are: the value must be readable
 * during render, and its server snapshot must be a constant. `getServerSnapshot`
 * answers "there is no browser clock here", which is what makes the static
 * render fall back to the server's own `when` and produce byte-identical markup
 * to what this app rendered before the component existed.
 *
 * The absolute instant is never hidden. It is the `title` and the `dateTime`, so
 * hovering answers "8m ago relative to what" and a screen reader reads a machine
 * timestamp rather than a phrase whose baseline it cannot see.
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
 * Cached, not `Date.now()` inline: `useSyncExternalStore` calls this during and
 * after render and treats a changed value as a torn read, so a fresh clock read
 * here would re-render the page forever.
 */
function browserNow(): number | null {
  return now;
}

/** No clock, and no reader with a stopwatch. The server's phrase stands. */
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

  // An instant the read model could not supply is not a zero to render. If
  // there is a phrase, it is all there is; if there is not, nothing is stated.
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
