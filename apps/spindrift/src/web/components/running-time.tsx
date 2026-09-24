/**
 * A ticking duration on the browser's clock, at second resolution. Its own
 * component, so each tick re-renders the digits and not the page.
 */
import { useEffect, useState } from 'react';

/** `1:04` up to an hour, then `1:02:09`. */
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
  /** ISO 8601 instant the run started. */
  since: string;
  /** False freezes the number where it stands. */
  active: boolean;
  className?: string;
}) {
  const started = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Read from the wall clock each tick, so a throttled background tab still
    // shows the true duration.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  // An unparseable start has no duration to show.
  if (Number.isNaN(started)) return null;

  return (
    <span className={className}>
      {formatDuration((active ? now : Math.max(now, started)) - started)}
    </span>
  );
}
