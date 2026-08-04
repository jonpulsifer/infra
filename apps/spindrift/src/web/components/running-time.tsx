/**
 * How long the thing on screen has been going, counting.
 *
 * `elapsedSince` in the domain answers a different question — *when* something
 * happened, projected against the server's clock, at minute resolution, because
 * "8m ago" is the right grain for a release from this afternoon. This answers
 * *how long it has been going*, at second resolution, and it has to tick.
 *
 * That is why it computes in the browser, which the domain's helper deliberately
 * does not: a duration measured from a server-supplied start is off by whatever
 * the two clocks disagree about, and a second or two of skew is invisible in a
 * number whose whole job is to keep moving. A relative *instant* computed the
 * same way would be a wrong fact; a running timer is a sign of life.
 *
 * **It is its own component so it is its own re-render.** A hook in the screen
 * above would re-render the whole attempt page every second, log pane and all,
 * to move two digits. The interval also stops the moment `active` goes false,
 * so a settled release is not paying a timer to display a constant.
 */
import { useEffect, useState } from 'react';

/** `1:04` up to an hour, then `1:02:09`. Never a bare count of seconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function RunningTime({
  since,
  active,
  className,
}: {
  /** ISO-8601 instant the run started, as the read model carries it. */
  since: string;
  /** Whether it is still going. False freezes the number where it stands. */
  active: boolean;
  className?: string;
}) {
  const started = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Re-synced from the wall clock each tick rather than incremented, so a
    // backgrounded tab that throttled its timers comes back showing the true
    // duration instead of however many ticks it was allowed to run.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // A start the read model could not supply is not a zero to render. There is
  // no duration to state, so nothing is stated.
  if (Number.isNaN(started)) return null;

  return (
    <span className={className}>
      {formatDuration((active ? now : Math.max(now, started)) - started)}
    </span>
  );
}
