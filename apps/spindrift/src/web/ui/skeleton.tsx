/**
 * The shape of the content that is coming, while it is not here yet.
 *
 * Twelve screens said `Loading apps…` in muted italics and then replaced it
 * with a page of a completely different height, which loses the reader's place
 * on every navigation. A skeleton is not decoration for that: it is a promise
 * about the layout, so the thing that arrives lands where the eye is already
 * looking.
 *
 * It deliberately does **not** know what it is standing in for. No `variant`,
 * no `lines={rows}` per screen shape — a caller composes the blocks inside its
 * own container, because only the caller knows whether the real thing is a
 * table of six rows or a hero and two cards. The two helpers below are the two
 * shapes that showed up more than twice; a third one belongs at its call site
 * until it does.
 *
 * `aria-hidden` throughout, and no `aria-busy` here. The status a screen reader
 * needs is a sentence, and the screens own that sentence — announcing a grey
 * rectangle is worse than announcing nothing.
 */
import { cn } from './utils.ts';

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'motion-safe:animate-pulse rounded-sm bg-secondary',
        'h-4 w-full',
        className,
      )}
    />
  );
}

/**
 * A paragraph's worth of lines, the last one short.
 *
 * The short last line is the whole trick — equal-length bars read as a table,
 * and prose does not end flush.
 */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: Math.max(1, lines) }, (_, index) => (
        <Skeleton
          key={index}
          className={index === lines - 1 ? 'h-3 w-2/5' : 'h-3'}
        />
      ))}
    </div>
  );
}

/** A ledger's worth of rows, at the height `DataTable` actually renders. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="flex flex-col divide-y divide-border-soft">
      {Array.from({ length: Math.max(1, rows) }, (_, index) => (
        <div key={index} className="flex items-center gap-4 px-3 py-2.5">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
