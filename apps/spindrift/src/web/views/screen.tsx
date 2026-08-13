/**
 * What a screen shows while it has no data, and what it shows when the read
 * that would have given it some did not.
 *
 * Every screen under this directory is in one of three states, and they share a
 * container because they did not, and that was the visible bug: six screens
 * rendered `Loading Overview…` inside `max-w-[1040px]` and then mounted their
 * content inside `max-w-[1320px]`, so arriving anywhere shifted the whole page
 * sideways the instant the read returned. `Page` names the two widths, and a
 * loading state that passes the same one its screen passes cannot disagree
 * with it.
 *
 * `LedgerSkeleton` is a header and rows, `DetailSkeleton` is a hero and cards —
 * the two shapes the product actually loads. Neither tries to be a picture of
 * the real screen; a skeleton is a promise about *where* things land, and one
 * that chases the layout is one more thing to keep in sync. A screen whose
 * loading shape is neither of those keeps its own beside itself, which is why
 * the Overview tiles and the creation flow's two phases are not here.
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
 * One ruled row of the Connections screen, loading.
 *
 * No `Page` around it, unlike every other skeleton here: the Targets and
 * Repositories screens only ever render inside `ConnectionsSettings`'
 * `divide-y` stack, so a centred max-width column would indent them out of
 * alignment with the two sections that resolved first — which is precisely the
 * jump this screen was worst at, three grey lines settling at three different
 * moments and shifting the ones below each time.
 */
export function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4 py-6">
      <Skeleton className="h-4 w-40" />
      <SkeletonRows rows={rows} />
    </div>
  );
}

/**
 * A load that failed, with the button that re-runs it.
 *
 * Every caller passes `onRetry`, and every one of them had to grow a token to
 * do it — `useRead`'s `reload` is that token, once. That is the change: a
 * screen whose read failed has nothing on it, so the reader's only previous
 * way forward was reloading a hash-routed application to re-run one query.
 */
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

/**
 * An id in the path that names nothing.
 *
 * Three screens rendered this as a centred card with an eyebrow, a heading, the
 * server's sentence and a `Back to Apps` button — the same card three times,
 * differing in two words. It is the same failure `ScreenFailure` renders, plus
 * the one thing a not-found has that a transport failure does not: somewhere
 * definite to go.
 */
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
 * The newest page of a ledger over the page the reader is holding.
 *
 * Both ledgers re-read their first page on a cadence while the reader may have
 * paged older rows in below it, and the two answers overlap: the read is
 * authoritative about the rows it carries and knows nothing about the rest, so
 * they are keyed by id and re-sorted rather than concatenated.
 */
export function mergeLedger<T extends { readonly id: number }>(
  first: readonly T[],
  second: readonly T[],
): readonly T[] {
  const byId = new Map(second.map((item) => [item.id, item]));
  for (const item of first) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}
