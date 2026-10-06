/**
 * Loading, failure and not-found states for the screens in this directory. A
 * loading state takes its screen's `Page` width, so nothing shifts on arrival.
 */
import { Button } from '../ui/button.tsx';
import { ErrorState } from '../ui/error-state.tsx';
import { Page } from '../ui/page.tsx';
import { Skeleton, SkeletonRows } from '../ui/skeleton.tsx';

export function LedgerSkeleton({
  width = 'wide',
  rows = 6,
}: {
  width?: 'wide' | 'reading';
  rows?: number;
}) {
  return (
    <Page width={width}>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64" />
      </div>
      <SkeletonRows rows={rows} />
    </Page>
  );
}

export function DetailSkeleton() {
  return (
    <Page width="reading">
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-28" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </Page>
  );
}

/**
 * One loading section of the Connections screen. It has no `Page`, since the
 * Targets and Repositories sections render inside `ConnectionsSettings`.
 */
export function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4 py-6">
      <Skeleton className="h-4 w-40" />
      <SkeletonRows rows={rows} />
    </div>
  );
}

export function ScreenFailure({
  title,
  message,
  onRetry,
  width = 'wide',
}: {
  title: string;
  message: string;
  onRetry: () => void;
  width?: 'wide' | 'reading';
}) {
  return (
    <Page width={width}>
      <ErrorState title={title} message={message} onRetry={onRetry} />
    </Page>
  );
}

/** An id in the path that names nothing. */
export function ScreenNotFound({
  title,
  message,
  onNavigate,
}: {
  title: string;
  message: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Page width="reading">
      <ErrorState
        title={title}
        code="NOT_FOUND"
        message={message}
        secondary={
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate('/apps')}
          >
            Back to Apps
          </Button>
        }
      />
    </Page>
  );
}

/**
 * Two overlapping ledger pages as one, keyed by id with `first` winning, newest
 * first. A re-read first page overlaps the older pages already loaded below it.
 */
export function mergeLedger<T extends { readonly id: number }>(
  first: readonly T[],
  second: readonly T[],
): readonly T[] {
  const byId = new Map(second.map((item) => [item.id, item]));
  for (const item of first) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}
