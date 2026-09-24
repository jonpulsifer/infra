/**
 * Discord resets the bot token when the daily IDENTIFY budget runs out, and
 * `@discordjs/ws` checks it only at startup. The shard calls this throttler
 * before every IDENTIFY and never before a RESUME.
 */
import type { APIGatewaySessionStartLimit } from 'discord-api-types/v10';
import type { Clock } from './clock.ts';
import { type Log, plain } from './log.ts';

export type SessionStartLimit = APIGatewaySessionStartLimit;

export const RESERVE_DIVISOR = 5;
export const MAX_IDENTIFIES_PER_HOUR = 10;
export const MIN_IDENTIFY_SPACING_MS = 5_000;
/** The shortest sleep before re-reading the budget, so a zero never spins. */
export const MIN_RESET_SLEEP_MS = 5_000;
export const FETCH_RETRY_MS = 5_000;
export const FETCH_RETRY_MAX_MS = 60_000;
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

  // Throw only on abort or breach: the shard answers any other rejection by
  // reconnecting and identifying again.
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

  async waitForBudget(signal: AbortSignal): Promise<void> {
    const { clock, log } = this.opts;
    let retry = FETCH_RETRY_MS;
    for (;;) {
      let limit: SessionStartLimit;
      try {
        limit = await this.opts.fetchLimit();
      } catch (error) {
        log.warn('gateway budget read failed; retrying', {
          error: plain(error),
          retryMs: retry,
        });
        await clock.sleep(retry, signal);
        retry = Math.min(retry * 2, FETCH_RETRY_MAX_MS);
        continue;
      }
      retry = FETCH_RETRY_MS;
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
      const sleepMs = Math.max(limit.reset_after, MIN_RESET_SLEEP_MS);
      log.warn('identify refused below reserve; sleeping to reset', {
        total: limit.total,
        remaining: limit.remaining,
        reserve,
        resetAfterMs: limit.reset_after,
        sleepMs,
      });
      await clock.sleep(sleepMs, signal);
    }
  }

  private prune(): void {
    const floor = this.opts.clock.now() - HOUR_MS;
    while (this.identifies.length > 0 && (this.identifies[0] ?? 0) < floor) {
      this.identifies.shift();
    }
  }
}
