/**
 * The abuse floor on its own: what a bucket refuses, and what a flood of fresh
 * keys does to a key that is being held.
 */
import { describe, expect, test } from 'bun:test';
import { addressOf } from '../../server/http.ts';
import {
  CLAIM_BUCKET,
  DailyCap,
  secondsToMidnight,
  TokenBucket,
} from '../../server/limits.ts';

function from(address: string): Request {
  return new Request('http://kthx.test/api/sites', {
    headers: { 'cf-connecting-ip': address },
  });
}

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

describe('the address a bucket is keyed by', () => {
  test('two addresses in one /64 are one key', () => {
    // What a residential customer is handed is a /64, so two addresses out of
    // it must not be two allowances — compressed, which is the form that
    // arrives, as much as expanded.
    expect(addressOf(from('2001:db8::1'), undefined)).toBe(
      addressOf(from('2001:db8::2'), undefined),
    );
    expect(addressOf(from('2001:db8::1'), undefined)).toBe(
      addressOf(from('2001:0db8:0000:0000:aaaa:bbbb:cccc:dddd'), undefined),
    );
    expect(addressOf(from('2001:db8:1::1'), undefined)).not.toBe(
      addressOf(from('2001:db8::1'), undefined),
    );
  });

  test('IPv4 keys by itself, and an empty header is no address at all', () => {
    expect(addressOf(from('198.51.100.7'), undefined)).toBe('198.51.100.7');
    expect(addressOf(new Request('http://kthx.test/'), undefined)).toBe(null);
  });
});
