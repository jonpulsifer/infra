/**
 * The abuse floor on its own: what a bucket refuses, and what a flood of fresh
 * keys does to a key that is being held.
 */
import { describe, expect, test } from 'bun:test';
import {
  CLAIM_BUCKET,
  DailyCap,
  secondsToMidnight,
  TokenBucket,
} from '../../server/limits.ts';

describe('the token bucket', () => {
  test('gives a burst, then refuses, then refills with time', () => {
    const bucket = new TokenBucket(CLAIM_BUCKET);
    const start = Date.now();
    for (let i = 0; i < CLAIM_BUCKET.capacity; i += 1) {
      expect(bucket.spend('one', start)).toBe(false);
    }
    expect(bucket.spend('one', start)).toBe(true);
    // Six a minute: ten seconds buys exactly one.
    expect(bucket.spend('one', start + 10_000)).toBe(false);
    expect(bucket.spend('one', start + 10_000)).toBe(true);
  });

  test('an unknown address is not rate limited', () => {
    expect(new TokenBucket(CLAIM_BUCKET).spend(null)).toBe(false);
  });

  test('a flood of fresh keys does not reset one being held', () => {
    const bucket = new TokenBucket(CLAIM_BUCKET);
    const now = Date.now();
    while (!bucket.spend('held', now)) {
      // drain it
    }
    for (let i = 0; i < 10_001; i += 1) {
      bucket.spend(`10.0.${i >> 8}.${i & 255}`, now);
    }
    expect(bucket.spend('held', now)).toBe(true);
  });
});

describe('the daily cap', () => {
  test('charges the act, not the attempt', () => {
    const cap = new DailyCap(2);
    expect(cap.full('site')).toBe(false);
    // Asking does not spend: twenty refused claims must not cost a day.
    expect(cap.full('site')).toBe(false);
    cap.count('site');
    cap.count('site');
    expect(cap.full('site')).toBe(true);
    expect(cap.full('other')).toBe(false);
  });

  test('the wait it reports is the rest of the UTC day', () => {
    const seconds = secondsToMidnight();
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(86_400);
  });
});
