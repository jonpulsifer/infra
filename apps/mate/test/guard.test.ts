import { describe, expect, test } from 'bun:test';
import {
  IdentifyBudget,
  MAX_IDENTIFIES_PER_HOUR,
  MIN_IDENTIFY_SPACING_MS,
  reserveOf,
  type SessionStartLimit,
} from '../src/guard.ts';
import { silentLog } from '../src/log.ts';
import { FakeClock, settle } from './support.ts';

function limit(remaining: number, reset_after = 3_600_000): SessionStartLimit {
  return { total: 1000, remaining, reset_after, max_concurrency: 1 };
}

function build(limits: SessionStartLimit[], maxPerHour?: number) {
  const clock = new FakeClock();
  const seen: SessionStartLimit[] = [];
  const breaches: string[] = [];
  let reads = 0;
  const budget = new IdentifyBudget({
    clock,
    log: silentLog,
    maxPerHour,
    fetchLimit: async () => {
      const next = limits[Math.min(reads, limits.length - 1)]!;
      reads += 1;
      return next;
    },
    onLimit: (l) => seen.push(l),
    onBreach: (reason) => breaches.push(reason),
  });
  return { clock, budget, seen, breaches, reads: () => reads };
}

const signal = new AbortController().signal;

describe('the identify budget', () => {
  test('the reserve is a fifth of the total, read from the limit', () => {
    expect(reserveOf(limit(999))).toBe(200);
    expect(reserveOf({ ...limit(0), total: 2000 })).toBe(400);
  });

  test('identifies at once while the budget is above the reserve', async () => {
    const { budget, reads, seen } = build([limit(800)]);
    await budget.waitForIdentify(0, signal);
    expect(reads()).toBe(1);
    expect(seen).toEqual([limit(800)]);
    expect(budget.identifiedThisHour).toBe(1);
  });

  test('refuses below the reserve and sleeps to reset_after instead of throwing', async () => {
    const { clock, budget, reads } = build([limit(199, 90_000), limit(1000)]);
    let done = false;
    const wait = budget.waitForIdentify(0, signal).then(() => {
      done = true;
    });
    await settle();
    expect(reads()).toBe(1);
    expect(done).toBe(false);
    await clock.advance(89_999);
    expect(done).toBe(false);
    await clock.advance(1);
    await wait;
    expect(done).toBe(true);
    expect(reads()).toBe(2);
  });

  test('re-reads the limit before every identify', async () => {
    const { clock, budget, reads } = build([limit(900)]);
    await budget.waitForIdentify(0, signal);
    await clock.advance(MIN_IDENTIFY_SPACING_MS);
    await budget.waitForIdentify(0, signal);
    expect(reads()).toBe(2);
  });

  test('spaces two identifies at least five seconds apart', async () => {
    const { clock, budget } = build([limit(900)]);
    await budget.waitForIdentify(0, signal);
    let done = false;
    const second = budget.waitForIdentify(0, signal).then(() => {
      done = true;
    });
    await clock.advance(MIN_IDENTIFY_SPACING_MS - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    await second;
    expect(done).toBe(true);
  });

  test('breaches the process cap on the eleventh identify in an hour and frees it as the hour rolls', async () => {
    const { clock, budget, breaches } = build([limit(900)]);
    for (let i = 0; i < MAX_IDENTIFIES_PER_HOUR; i += 1) {
      await budget.waitForIdentify(0, signal);
      await clock.advance(MIN_IDENTIFY_SPACING_MS);
    }
    await expect(budget.waitForIdentify(0, signal)).rejects.toThrow(
      'cap is 10',
    );
    expect(breaches).toHaveLength(1);
    await clock.advance(3_600_000);
    await budget.waitForIdentify(0, signal);
    expect(breaches).toHaveLength(1);
  });

  test('a sleep to reset is abandoned when the shard closes', async () => {
    const { clock, budget } = build([limit(0, 60_000)]);
    const controller = new AbortController();
    const wait = budget.waitForIdentify(0, controller.signal);
    await settle();
    controller.abort(new Error('closed'));
    await expect(wait).rejects.toThrow('closed');
    expect(clock.pendingTimers).toBe(0);
  });
});
