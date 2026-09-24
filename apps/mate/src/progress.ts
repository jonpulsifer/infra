/**
 * The one line a thread shows while it waits for an answer, rewritten as the
 * wait moves on. Nothing here can fail a turn, and `end` is the only way out.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import type { Notice } from './surface.ts';

// The moving count shows mate is still working. One edit per waiting thread
// stays well inside either surface's rate limit.
export const PROGRESS_CADENCE_MS = 5_000;

export class Progress {
  private line: string;
  private readonly startedAt: number;
  private timer: Handle | null = null;
  private chain: Promise<void> = Promise.resolve();
  private over = false;
  private failures = 0;

  constructor(
    private readonly notice: Notice,
    private readonly clock: Clock,
    private readonly log: Log,
    private readonly threadId: string,
    line: string,
    private readonly cadenceMs = PROGRESS_CADENCE_MS,
  ) {
    this.line = line;
    this.startedAt = clock.now();
    this.paint();
    this.tick();
  }

  /** The elapsed count carries on from the first line. */
  say(line: string): void {
    if (this.over || line === this.line) return;
    this.line = line;
    this.paint();
  }

  /**
   * A sentence replaces the line and `null` removes it. false means the surface
   * refused, so the caller still has to say it.
   */
  async end(text: string | null): Promise<boolean> {
    if (this.over) return false;
    this.over = true;
    if (this.timer) this.clock.cancel(this.timer);
    this.timer = null;
    let landed = true;
    this.chain = this.chain
      .then(() => this.notice.done(text))
      .catch((error) => {
        landed = false;
        this.failed(error);
      });
    await this.chain;
    return landed;
  }

  private tick(): void {
    this.timer = this.clock.after(this.cadenceMs, () => {
      if (this.over) return;
      this.paint();
      this.tick();
    });
  }

  // Queued behind the last frame: two draws racing the first would post the
  // line twice.
  private paint(): void {
    const text = this.elapsed();
    this.chain = this.chain
      .then(() => (this.over ? undefined : this.notice.say(text)))
      .catch((error) => this.failed(error));
  }

  // No count on the first draw: a line opening with "0s" reads as a stopwatch.
  private elapsed(): string {
    const seconds = Math.floor((this.clock.now() - this.startedAt) / 1000);
    return seconds > 0 ? `${this.line} · ${seconds}s` : this.line;
  }

  private failed(error: unknown): void {
    this.failures += 1;
    if (this.failures > 1) return;
    this.log.warn('the waiting line could not be drawn', {
      threadId: this.threadId,
      error: plain(error),
    });
  }
}
