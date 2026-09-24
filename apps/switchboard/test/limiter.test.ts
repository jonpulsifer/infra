import { describe, expect, test } from 'bun:test';
import { Limiter } from '../src/limiter.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

describe('Limiter', () => {
  test('allows up to the daily cap, then refuses', () => {
    const limiter = new Limiter({ dailyCap: 2, cooldownMs: 0 });
    expect(limiter.attempt(0)).toEqual({ ok: true });
    expect(limiter.attempt(1)).toEqual({ ok: true });
    expect(limiter.attempt(2)).toEqual({ ok: false, reason: 'daily-cap' });
  });

  test('enforces the cooldown between attempts', () => {
    const limiter = new Limiter({ dailyCap: 10, cooldownMs: 5 * MIN });
    expect(limiter.attempt(0)).toEqual({ ok: true });
    expect(limiter.attempt(4 * MIN)).toEqual({
      ok: false,
      reason: 'cooldown',
    });
    expect(limiter.attempt(5 * MIN)).toEqual({ ok: true });
  });

  test('a refused attempt is not recorded, so it does not spend the cap', () => {
    const limiter = new Limiter({ dailyCap: 1, cooldownMs: 5 * MIN });
    expect(limiter.attempt(0)).toEqual({ ok: true });
    expect(limiter.attempt(MIN)).toEqual({ ok: false, reason: 'cooldown' });
    // Still capped at 1/day even once the cooldown passes, proving the
    // refused call above never counted against it.
    expect(limiter.attempt(5 * MIN)).toEqual({
      ok: false,
      reason: 'daily-cap',
    });
  });

  test('the daily cap is a rolling 24h window, not a calendar day', () => {
    const limiter = new Limiter({ dailyCap: 1, cooldownMs: 0 });
    expect(limiter.attempt(0)).toEqual({ ok: true });
    expect(limiter.attempt(DAY - 1)).toEqual({
      ok: false,
      reason: 'daily-cap',
    });
    expect(limiter.attempt(DAY)).toEqual({ ok: true });
  });
});
