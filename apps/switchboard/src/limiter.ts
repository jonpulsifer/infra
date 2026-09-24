const DAY_MS = 24 * 60 * 60_000;

export type LimitReason = 'cooldown' | 'daily-cap';
export type LimitResult = { ok: true } | { ok: false; reason: LimitReason };

export interface LimiterOptions {
  readonly dailyCap: number;
  readonly cooldownMs: number;
}

/**
 * Counts attempts, not successes: a call that fails at ElevenLabs still
 * spends the cap and starts the cooldown, so a stuck key or a bad number
 * cannot be hammered for free.
 */
export class Limiter {
  private readonly attempts: number[] = [];
  // -Infinity, not 0: a real first attempt can land at timestamp 0 (tests do
  // this deliberately), and 0 is falsy, which would silently skip the
  // cooldown check below on that first attempt.
  private lastAttempt = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: LimiterOptions) {}

  /**
   * A synchronous check-and-reserve: nothing awaits between the check and the
   * recorded timestamp, so concurrent callers on Bun's single event loop
   * cannot both slip through.
   */
  attempt(now: number): LimitResult {
    if (now - this.lastAttempt < this.opts.cooldownMs) {
      return { ok: false, reason: 'cooldown' };
    }
    this.prune(now);
    if (this.attempts.length >= this.opts.dailyCap) {
      return { ok: false, reason: 'daily-cap' };
    }
    this.attempts.push(now);
    this.lastAttempt = now;
    return { ok: true };
  }

  private prune(now: number): void {
    // <=, not <: an attempt exactly 24h old has fully rolled out of the window.
    const floor = now - DAY_MS;
    while (this.attempts.length > 0 && (this.attempts[0] ?? 0) <= floor) {
      this.attempts.shift();
    }
  }
}
