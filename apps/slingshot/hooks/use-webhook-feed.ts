'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import {
  clearHistoryAction,
  pollFeedAction,
  readFeedAction,
} from '@/lib/actions';
import type { Webhook } from '@/lib/types';
import {
  clearCachedWebhooks,
  getCachedWebhooksEntry,
  setCachedWebhooks,
} from '@/lib/webhook-cache';

/**
 * Everything about a project's live webhook feed: the local-first cache, the
 * freshness poll, and which webhook is selected.
 *
 * One module owns the list. Previously the state was split between
 * `webhook-section` (hydrate plus a refreshKey handshake) and `webhook-viewer`
 * (six effects), with both halves re-reading the cache the other half wrote -
 * so there was no single place to fix a bug in it, and no interface a test
 * could cross.
 */

const POLL_INTERVAL_MS = 2000;

export interface WebhookFeed {
  webhooks: Webhook[];
  /** The webhook being inspected, or null when the feed is empty. */
  selected: Webhook | null;
  select: (webhook: Webhook) => void;
  /** Delete every webhook for this project, server and cache. */
  clear: () => Promise<void>;
  /** Force a poll now - after sending a webhook, say. */
  refresh: () => void;
  /** True until the first list (cached or fetched) is in hand. */
  isLoading: boolean;
  /** False when the poll is erroring. */
  isConnected: boolean;
  /** True when the list came from a cache entry past its stale age. */
  isStale: boolean;
}

export function useWebhookFeed(projectSlug: string): WebhookFeed {
  const searchParams = useSearchParams();
  const selectedIdFromQuery = searchParams.get('webhook');

  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStale, setIsStale] = useState(false);

  // The head of the list at the time of the last render, so a newly arrived
  // webhook can take over the selection only when the user was already
  // watching the newest one.
  const headIdRef = useRef<string | null>(null);

  const applyList = useCallback((next: Webhook[]) => {
    setWebhooks(next);
    setSelectedId((current) => {
      if (next.length === 0) {
        return null;
      }
      if (current === null) {
        return next[0].id;
      }
      // Selection followed the head, so keep following it.
      if (current === headIdRef.current && next[0].id !== current) {
        return next[0].id;
      }
      // Selection was dropped from the buffer.
      return next.some((w) => w.id === current) ? current : next[0].id;
    });
    headIdRef.current = next[0]?.id ?? null;
  }, []);

  // Local-first hydrate. Runs on mount and whenever the project changes: reset,
  // show the cache immediately if there is one, and refresh behind it.
  useEffect(() => {
    let cancelled = false;

    setWebhooks([]);
    setSelectedId(null);
    headIdRef.current = null;
    setIsStale(false);

    const cached = getCachedWebhooksEntry(projectSlug);
    if (cached && cached.webhooks.length > 0) {
      applyList(cached.webhooks);
      setIsStale(cached.stale);
      setIsLoading(false);
    } else {
      setIsLoading(true);
    }

    const needsFetch = !cached || cached.stale;
    if (!needsFetch) {
      return () => {
        cancelled = true;
      };
    }

    readFeedAction(projectSlug)
      .then((result) => {
        if (cancelled) {
          return;
        }
        applyList(result.webhooks);
        setCachedWebhooks(
          projectSlug,
          result.webhooks,
          result.etag ?? undefined,
          result.maxSize,
        );
        setIsStale(false);
      })
      .catch((error) => {
        console.error('[feed] initial read failed:', error);
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectSlug, applyList]);

  // Freshness poll. The cached etag is read at call time rather than captured,
  // so a poll never asks with an etag the cache has already moved past.
  const {
    data: poll,
    mutate,
    error,
  } = useSWR(
    ['webhook-feed', projectSlug],
    () =>
      pollFeedAction(projectSlug, getCachedWebhooksEntry(projectSlug)?.etag),
    {
      refreshInterval: POLL_INTERVAL_MS,
      revalidateOnFocus: true,
      dedupingInterval: 1000,
      fallbackData: { changed: false as const },
    },
  );

  useEffect(() => {
    if (!poll?.changed) {
      return;
    }
    applyList(poll.webhooks);
    setCachedWebhooks(
      projectSlug,
      poll.webhooks,
      poll.etag ?? undefined,
      poll.maxSize,
    );
    setIsStale(false);
    setIsLoading(false);
  }, [poll, projectSlug, applyList]);

  // A ?webhook= id in the URL wins over the auto-advance, but only once the
  // webhook it names has actually arrived.
  useEffect(() => {
    if (!selectedIdFromQuery) {
      return;
    }
    if (webhooks.some((w) => w.id === selectedIdFromQuery)) {
      setSelectedId(selectedIdFromQuery);
    }
  }, [selectedIdFromQuery, webhooks]);

  const select = useCallback(
    (webhook: Webhook) => {
      setSelectedId(webhook.id);
      // Selecting by hand detaches from the head, so a new arrival does not
      // yank the pane out from under the user.
      headIdRef.current = null;
      writeSelectionToUrl(projectSlug, webhook.id);
    },
    [projectSlug],
  );

  const clear = useCallback(async () => {
    await clearHistoryAction(projectSlug);
    clearCachedWebhooks(projectSlug);
    setWebhooks([]);
    setSelectedId(null);
    headIdRef.current = null;
    await mutate();
  }, [projectSlug, mutate]);

  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);

  const selected = selectedId
    ? (webhooks.find((w) => w.id === selectedId) ?? null)
    : null;

  return {
    webhooks,
    selected,
    select,
    clear,
    refresh,
    isLoading,
    isConnected: !error,
    isStale,
  };
}

/**
 * Reflect the selection in the URL so it can be linked, without a navigation.
 * Skipped when the pathname has already moved on to another project.
 */
function writeSelectionToUrl(projectSlug: string, webhookId: string) {
  if (typeof window === 'undefined') {
    return;
  }
  if (window.location.pathname !== `/${projectSlug}`) {
    return;
  }
  const params = new URLSearchParams(window.location.search);
  params.set('webhook', webhookId);
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}?${params.toString()}`,
  );
}
