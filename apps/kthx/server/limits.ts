/**
 * The abuse floor: a token bucket and a per-UTC-day counter, both in memory.
 *
 * ponytail: per-replica, and the address is what the edge says it is. There is
 * one replica by construction (the realtime fan-out and the sites volume both
 * assume it), so a shared counter would be a second store to run for a bound
 * that already holds. The upgrade path is Postgres — or the edge's own rate
 * limiting — the day a second replica exists.
 *
 * Per-site quotas do the real bounding; these two only decide how fast anyone
 * can reach them.
 */

export interface BucketSpec {
  /** How many in a burst. */
  readonly capacity: number;
  /** How fast it refills. */
  readonly perSecond: number;
}

/** Thirty in a burst, then six a minute (v1), per address, on claim and upload. */
export const CLAIM_BUCKET: BucketSpec = { capacity: 30, perSecond: 0.1 };

/** Beyond this many keys the map is a memory leak rather than a limiter. */
const MAX_KEYS = 10_000;

export class TokenBucket {
  private readonly held = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly spec: BucketSpec) {}

  /** True when the key has no token left — the caller refuses. */
  spend(key: string | null, now = Date.now()): boolean {
    if (key === null) return false;
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
    if (bucket.tokens < 1) return true;
    bucket.tokens -= 1;
    return false;
  }

  /**
   * Make room by dropping a bucket that is still near full — one a flood of
   * fresh keys left behind — so the flood evicts only itself and never resets a
   * key that is being held.
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

/**
 * A count per key per UTC day, for the caps a token bucket cannot express: 20
 * claims per /64 a day, 60 uploads per site a day.
 *
 * The day rolls at UTC midnight for every key at once, which is also what
 * `retry-after` is computed from.
 */
export class DailyCap {
  private day = today();
  private counted = new Map<string, number>();

  constructor(private readonly limit: number) {}

  /** True when the key has spent its day. */
  full(key: string): boolean {
    this.roll();
    return (this.counted.get(key) ?? 0) >= this.limit;
  }

  /**
   * Spend one.
   *
   * Separate from {@link full} so a caller can charge the act rather than the
   * attempt: twenty refused claims must not spend a day's worth of allowance
   * that no site came out of.
   */
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

/** Seconds until the caps reset, for `retry-after` on a daily refusal. */
export function secondsToMidnight(now = Date.now()): number {
  return Math.ceil((86_400_000 - (now % 86_400_000)) / 1000);
}
