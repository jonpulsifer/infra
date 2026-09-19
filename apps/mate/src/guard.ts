/**
 * The identify-budget guard.
 *
 * Discord allows 1000 IDENTIFYs per app per 24 h and, on exhaustion, resets
 * the bot token. `@discordjs/ws` only refuses to *start* at `remaining < 1`:
 * its internal reconnect path re-identifies without re-reading the budget,
 * it keeps no reserve, and it throws instead of waiting for the window to
 * reset. This throttler is the one seam the shard calls before every IDENTIFY
 * and never before a RESUME, so the three gaps close here.
 */
import type { Clock } from './clock.ts';
import type { Log } from './log.ts';

export interface SessionStartLimit {
  total: number;
  remaining: number;
  reset_after: number;
  max_concurrency: number;
}

export const RESERVE_DIVISOR = 5;
export const MAX_IDENTIFIES_PER_HOUR = 10;
export const MIN_IDENTIFY_SPACING_MS = 5_000;
const HOUR_MS = 3_600_000;

export interface IdentifyBudgetOptions {
  fetchLimit(): Promise<SessionStartLimit>;
  clock: Clock;
  log: Log;
  /** Called when the process-local cap is breached; expected not to return. */
  onBreach(reason: string): void;
  onLimit?(limit: SessionStartLimit): void;
  maxPerHour?: number;
}

export function reserveOf(limit: SessionStartLimit): number {
  return Math.floor(limit.total / RESERVE_DIVISOR);
}

export class IdentifyBudget {
  private readonly identifies: number[] = [];
  private readonly maxPerHour: number;

  constructor(private readonly opts: IdentifyBudgetOptions) {
    this.maxPerHour = opts.maxPerHour ?? MAX_IDENTIFIES_PER_HOUR;
  }

  get identifiedThisHour(): number {
    this.prune();
    return this.identifies.length;
  }

  async waitForIdentify(_shardId: number, signal: AbortSignal): Promise<void> {
    const { clock, log } = this.opts;
    this.prune();
    if (this.identifies.length >= this.maxPerHour) {
      const reason = `${this.identifies.length} identifies in the last hour, cap is ${this.maxPerHour}`;
      log.error('identify cap breached', { reason });
      this.opts.onBreach(reason);
      throw new Error(reason);
    }
    await this.waitForBudget(signal);
    const last = this.identifies.at(-1);
    if (last !== undefined) {
      const gap = MIN_IDENTIFY_SPACING_MS - (clock.now() - last);
      if (gap > 0) await clock.sleep(gap, signal);
    }
    this.identifies.push(clock.now());
  }

  /** Resolves once the daily budget is above the reserve, sleeping to the reset if not. */
  async waitForBudget(signal: AbortSignal): Promise<void> {
    const { clock, log } = this.opts;
    for (;;) {
      const limit = await this.opts.fetchLimit();
      this.opts.onLimit?.(limit);
      const reserve = reserveOf(limit);
      if (limit.remaining >= reserve) {
        log.info('identify budget ok', {
          total: limit.total,
          remaining: limit.remaining,
          reserve,
          resetAfterMs: limit.reset_after,
          maxConcurrency: limit.max_concurrency,
        });
        break;
      }
      log.warn('identify refused below reserve; sleeping to reset', {
        total: limit.total,
        remaining: limit.remaining,
        reserve,
        resetAfterMs: limit.reset_after,
      });
      await clock.sleep(limit.reset_after, signal);
    }
  }

  private prune(): void {
    const floor = this.opts.clock.now() - HOUR_MS;
    while (this.identifies.length > 0 && (this.identifies[0] ?? 0) < floor) {
      this.identifies.shift();
    }
  }
}
