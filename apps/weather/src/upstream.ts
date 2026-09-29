/**
 * Every upstream request goes through here: bounded, because Bun's fetch has
 * no happy-eyeballs fallback and an unanswered AAAA route hangs forever, and
 * cached, so a chatty agent costs the providers one request per TTL.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ENTRIES = 2_000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type Fetch = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<Response>;

interface Entry {
  expires: number;
  value: Promise<unknown>;
}

export class Upstream {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** A failed request is not cached, so the next caller retries it. */
  json<T>(url: string, ttlMs: number, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.cached(url, ttlMs, async () => {
      const res = await this.get(url, timeoutMs);
      return (await res.json()) as T;
    });
  }

  text(url: string, ttlMs: number, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return this.cached(url, ttlMs, async () => {
      const res = await this.get(url, timeoutMs);
      return res.text();
    });
  }

  cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = load();
    this.cache.delete(key);
    this.cache.set(key, { expires: now + ttlMs, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    // Map keeps insertion order, so the first key is the oldest.
    while (this.cache.size > MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return value;
  }

  private async get(url: string, timeoutMs: number): Promise<Response> {
    const host = new URL(url).host;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json, text/html;q=0.9' },
      });
    } catch (error) {
      throw new UpstreamError(
        `${host} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!res.ok) {
      throw new UpstreamError(
        `${host} answered HTTP ${res.status}`,
        res.status,
      );
    }
    return res;
  }
}
