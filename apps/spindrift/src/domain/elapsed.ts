/**
 * How long ago something happened, in the words a screen uses.
 *
 * It lives in the domain rather than in a view because the views are rendered
 * from immutable read models projected by commands (`src/web/model.ts`), and a
 * relative time computed in the browser would be computed against the browser's
 * clock. Every command already carries a {@link Clock}; this is what turns it
 * into the one string a timeline entry needs.
 *
 * The scale stops at days. A release from last March is not more legible as
 * "142d ago" than as its date, and the screens that need the exact instant
 * carry the ISO timestamp beside the word.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `when` relative to `now` — "just now", "8m ago", "2h ago", "3d ago".
 *
 * A future instant reads as "just now" rather than negative: clock skew between
 * a database default and a command's clock is ordinary, and "in -2s" would say
 * the machine is broken when only the two clocks disagree.
 */
export function elapsedSince(when: Date, now: Date): string {
  const delta = now.getTime() - when.getTime();
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  return `${Math.floor(delta / DAY)}d ago`;
}
