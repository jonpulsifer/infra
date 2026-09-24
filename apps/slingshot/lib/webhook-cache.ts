// Each project's webhook list in localStorage, shown before the first fetch
// returns.

import type { Webhook } from './types';

const CACHE_PREFIX = 'slingshot_webhooks_';
const CACHE_MAX_AGE = 30 * 60 * 1000;
const CACHE_STALE_AGE = 5 * 60 * 1000; // older entries show while refetching

interface CachedWebhooks {
  webhooks: Webhook[];
  etag?: string;
  maxSize?: number;
  timestamp: number;
}

// null on the server, or when the entry is missing, expired or unreadable.
export function getCachedWebhooksEntry(
  projectSlug: string,
): (CachedWebhooks & { stale: boolean }) | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const cacheKey = `${CACHE_PREFIX}${projectSlug}`;
    const cached = localStorage.getItem(cacheKey);

    if (!cached) {
      return null;
    }

    const data: CachedWebhooks = JSON.parse(cached);
    const age = Date.now() - data.timestamp;
    const stale = age > CACHE_STALE_AGE;

    if (age > CACHE_MAX_AGE) {
      localStorage.removeItem(cacheKey);
      return null;
    }

    return { ...data, stale };
  } catch (error) {
    console.error('Failed to read webhook cache:', error);
    try {
      const cacheKey = `${CACHE_PREFIX}${projectSlug}`;
      localStorage.removeItem(cacheKey);
    } catch {}
    return null;
  }
}

export function setCachedWebhooks(
  projectSlug: string,
  webhooks: Webhook[],
  etag?: string,
  maxSize?: number,
): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const cacheKey = `${CACHE_PREFIX}${projectSlug}`;
    const data: CachedWebhooks = {
      webhooks,
      etag,
      maxSize,
      timestamp: Date.now(),
    };

    localStorage.setItem(cacheKey, JSON.stringify(data));
  } catch (error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      console.warn('localStorage quota exceeded, clearing old cache entries');
      clearOldCacheEntries();
      try {
        const cacheKey = `${CACHE_PREFIX}${projectSlug}`;
        const data: CachedWebhooks = {
          webhooks,
          etag,
          maxSize,
          timestamp: Date.now(),
        };
        localStorage.setItem(cacheKey, JSON.stringify(data));
      } catch (retryError) {
        console.error('Failed to cache webhooks after cleanup:', retryError);
      }
    } else {
      console.error('Failed to cache webhooks:', error);
    }
  }
}

export function clearCachedWebhooks(projectSlug: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const cacheKey = `${CACHE_PREFIX}${projectSlug}`;
    localStorage.removeItem(cacheKey);
  } catch (error) {
    console.error('Failed to clear webhook cache:', error);
  }
}

function clearOldCacheEntries(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const now = Date.now();
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) {
        try {
          const cached = localStorage.getItem(key);
          if (cached) {
            const data: CachedWebhooks = JSON.parse(cached);
            if (now - data.timestamp > CACHE_MAX_AGE) {
              keysToRemove.push(key);
            }
          }
        } catch {
          keysToRemove.push(key);
        }
      }
    }

    keysToRemove.forEach((key) => {
      localStorage.removeItem(key);
    });
  } catch (error) {
    console.error('Failed to clear old cache entries:', error);
  }
}

export function getAllCacheEntries(): {
  slug: string;
  timestamp: number;
  count: number;
  size: number;
  stale: boolean;
}[] {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const entries: {
      slug: string;
      timestamp: number;
      count: number;
      size: number;
      stale: boolean;
    }[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) {
        try {
          const slug = key.replace(CACHE_PREFIX, '');
          const cached = localStorage.getItem(key);
          if (cached) {
            const data: CachedWebhooks = JSON.parse(cached);
            const age = Date.now() - data.timestamp;
            entries.push({
              slug,
              timestamp: data.timestamp,
              count: data.webhooks.length,
              size: cached.length,
              stale: age > CACHE_STALE_AGE,
            });
          }
        } catch {}
      }
    }

    return entries.sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    console.error('Failed to get all cache entries:', error);
    return [];
  }
}

export function clearAllCachedWebhooks(): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      localStorage.removeItem(key);
    });
  } catch (error) {
    console.error('Failed to clear all cached webhooks:', error);
    throw error;
  }
}
