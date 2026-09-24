/**
 * How long ago something happened, in the words a screen uses. Commands compute
 * it against their own clock, never the browser's. The scale stops at days.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "8m ago", "2h ago", "3d ago". A future instant reads "just now",
 * since a database default and a command's clock can disagree.
 */
export function elapsedSince(when: Date, now: Date): string {
  const delta = now.getTime() - when.getTime();
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}
