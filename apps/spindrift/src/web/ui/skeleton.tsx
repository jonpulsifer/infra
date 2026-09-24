/**
 * Placeholder blocks in the shape of content still loading. Hidden from screen
 * readers, since each screen owns its loading sentence.
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

/** The last line is short, since equal-length bars read as a table. */
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

/** Rows padded as `DataTable` pads its cells. */
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
