/**
 * In-memory rate limits: a token bucket and a per-UTC-day counter. Per-site
 * quotas do the bounding; these decide how fast anyone reaches them.
 *
 * ponytail: per-replica, which holds while realtime and the sites volume
 * require one replica. Move to Postgres or edge limits before a second.
 */

export interface BucketSpec {
  readonly capacity: number;
  /** Tokens refilled per second. */
  readonly perSecond: number;
}

/** Per address, on claim and upload. */
export const CLAIM_BUCKET: BucketSpec = { capacity: 30, perSecond: 0.1 };

/**
 * Per address, on the public directory. Each page is an uncached query on the
 * control connection that every site host serves its files through.
 */
export const DIRECTORY_BUCKET: BucketSpec = { capacity: 60, perSecond: 1 };

/**
 * Each alone is bypassable: a cookie is free to discard, an IPv6 range holds
 * many /64s, and a site bucket alone lets one visitor spend everyone's share.
 */
export const WRITE_VISITOR: BucketSpec = { capacity: 60, perSecond: 0.5 };
export const WRITE_ADDRESS: BucketSpec = { capacity: 240, perSecond: 2 };
export const WRITE_SITE: BucketSpec = { capacity: 600, perSecond: 5 };

/** Beyond this many keys the map is a memory leak, not a limiter. */
const MAX_KEYS = 10_000;

export class TokenBucket {
  private readonly held = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly spec: BucketSpec) {}

  /** True when the key has no token left. */
  spend(key: string | null, now = Date.now()): boolean {
    if (key === null) return false;
    if (this.tokens(key, now) < 1) return true;
    this.take(key);
    return false;
  }

  /**
   * Separate from {@link spend} so {@link spendAll} can check every bucket
   * before charging any.
   */
  tokens(key: string, now = Date.now()): number {
    const bucket = this.held.get(key) ?? {
      tokens: this.spec.capacity,
      at: now,
    };
    bucket.tokens = Math.min(
      this.spec.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.spec.perSecond,
    );
    bucket.at = now;
    this.held.set(key, bucket);
    if (this.held.size > MAX_KEYS) this.evict();
    return bucket.tokens;
  }

  take(key: string): void {
    const bucket = this.held.get(key);
    if (bucket !== undefined) bucket.tokens -= 1;
  }

  /**
   * Drops a near-full bucket first, so a flood of fresh keys evicts itself and
   * never resets a key that is being held.
   */
  private evict(): void {
    for (const [key, bucket] of this.held) {
      if (bucket.tokens >= this.spec.capacity - 1) {
        this.held.delete(key);
        return;
      }
    }
    this.held.delete(this.held.keys().next().value as string);
  }
}

/** Shared with `/api/mcp`: a second instance would be a second allowance. */
export const writes = {
  visitor: new TokenBucket(WRITE_VISITOR),
  address: new TokenBucket(WRITE_ADDRESS),
  site: new TokenBucket(WRITE_SITE),
};

/** A count per key per UTC day; every key rolls at UTC midnight at once. */
export class DailyCap {
  private day = today();
  private counted = new Map<string, number>();

  constructor(private readonly limit: number) {}

  full(key: string): boolean {
    this.roll();
    return (this.counted.get(key) ?? 0) >= this.limit;
  }

  /** Separate from {@link full} so only a success is counted. */
  count(key: string): void {
    this.roll();
    this.counted.set(key, (this.counted.get(key) ?? 0) + 1);
    if (this.counted.size > MAX_KEYS) {
      this.counted.delete(this.counted.keys().next().value as string);
    }
  }

  private roll(): void {
    const now = today();
    if (now === this.day) return;
    this.day = now;
    this.counted.clear();
  }
}

function today(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Seconds until the daily caps reset. */
export function secondsToMidnight(now = Date.now()): number {
  return Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);
}

/**
 * Spends one token in each bucket, all or nothing. A `null` key (no cookie, no
 * address) skips that bucket; the others still bound the request.
 */
export function spendAll(
  pairs: readonly (readonly [TokenBucket, string | null])[],
  now = Date.now(),
): boolean {
  const keyed = pairs.filter(
    (pair): pair is readonly [TokenBucket, string] => pair[1] !== null,
  );
  if (keyed.some(([bucket, key]) => bucket.tokens(key, now) < 1)) return true;
  for (const [bucket, key] of keyed) bucket.take(key);
  return false;
}
