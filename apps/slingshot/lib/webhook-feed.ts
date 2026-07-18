/**
 * Consolidates the "has this changed since etag X" freshness comparison used
 * by the polling actions (pollWebhooksAction, pollStatsAction).
 *
 * This is polling-based staleness detection, not locking: the "etag" is just
 * a cheap timestamp-derived version marker computed server-side on every
 * write (see lib/storage.ts / lib/stats-storage.ts). No client-supplied
 * etag is ever checked against a write - a client can't use this to prevent
 * a write, only to avoid re-downloading data it already has. Historically
 * this was mislabeled in comments as "optimistic locking"; it's freshness
 * polling for a 2s stale-while-revalidate client (see webhook-cache.ts and
 * components/webhook-viewer.tsx).
 *
 * Before this module, the same "check changed -> compare etag -> fetch if
 * stale" branching lived independently in both pollWebhooksAction and
 * pollStatsAction. Consolidating it here means that logic only needs to be
 * understood (and fixed, if it's ever wrong) in one place.
 */

export interface ChangeCheck {
  changed: boolean;
  etag: string | null;
}

export interface FeedUpdate<T> {
  changed: boolean;
  data?: T;
  etag?: string;
}

/**
 * Given a cheap "did this change" check and, only if needed, a full data
 * fetch, determine whether `currentEtag` is stale and return fresh data
 * only when it is.
 *
 * @param currentEtag - The etag the caller already has (e.g. from cache).
 * @param checkChanged - Cheap check (metadata-only) for whether data changed.
 * @param fetchData - Full data fetch, only called when a refresh is needed.
 */
export async function resolveFeedUpdate<T>(
  currentEtag: string | null | undefined,
  checkChanged: () => Promise<ChangeCheck>,
  fetchData: (
    knownEtag: string | null,
  ) => Promise<{ data: T | null; etag: string | null }>,
): Promise<FeedUpdate<T>> {
  const { changed, etag: newEtag } = await checkChanged();

  // Nothing changed server-side, or the caller's etag already matches -
  // either way there's nothing fresh to send down.
  if (!changed || (currentEtag && newEtag === currentEtag)) {
    return { changed: false };
  }

  const { data, etag } = await fetchData(newEtag);
  return {
    changed: true,
    data: data ?? undefined,
    etag: etag || undefined,
  };
}
