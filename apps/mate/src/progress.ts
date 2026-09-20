/**
 * The acknowledgment a thread gets before it has an answer: one line saying
 * what mate is doing about the question just asked, rewritten as that changes,
 * and taken back the moment the turn's own frames take over.
 *
 * It exists because the wait is measured in tens of seconds and nothing used
 * to reach the human during it. The surface's working sign is raised by the
 * renderer, which is constructed after the sandbox is attached, so both
 * surfaces were silent for the whole of the part that is slow.
 *
 * Two rules hold it together. Nothing here can fail a turn — a line that
 * cannot be drawn is a warning and the wait goes on regardless — and `end` is
 * the only way out, so every path that stops waiting either replaces the line
 * with what happened or takes it away.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import type { Notice } from './surface.ts';

/**
 * How often the line is redrawn with nothing new to say. It is the elapsed
 * count moving that says mate is still there rather than wedged, and it is
 * one edit per waiting thread — well inside what either surface allows for a
 * thread count `MATE_MAX_CONCURRENT` caps at a handful.
 */
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

  /** What mate is doing now. The elapsed count carries on from the first line. */
  say(line: string): void {
    if (this.over || line === this.line) return;
    this.line = line;
    this.paint();
  }

  /**
   * The line's last word: a sentence replaces it, `null` takes it away. The
   * answer says whether that landed, because a caller that had something to
   * say still has to say it when the surface refused this — everything mate
   * tells a thread about a failed wait arrives this way.
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

  /**
   * Redraws on the cadence whether or not the step changed, because the
   * elapsed count is the half of the line that is always new.
   */
  private tick(): void {
    this.timer = this.clock.after(this.cadenceMs, () => {
      if (this.over) return;
      this.paint();
      this.tick();
    });
  }

  /**
   * One frame, queued behind the last: the surface holds a message id after
   * the first draw, so two draws racing would post the line twice.
   */
  private paint(): void {
    const text = this.elapsed();
    this.chain = this.chain
      .then(() => (this.over ? undefined : this.notice.say(text)))
      .catch((error) => this.failed(error));
  }

  /**
   * The line, with how long the human has been looking at it. The first draw
   * carries no count — there is nothing to report yet, and a line that opens
   * with "0s" reads as a stopwatch rather than an answer on its way.
   */
  private elapsed(): string {
    const seconds = Math.floor((this.clock.now() - this.startedAt) / 1000);
    return seconds > 0 ? `${this.line} · ${seconds}s` : this.line;
  }

  /** One warning a wait: the thread is already being made to watch a line. */
  private failed(error: unknown): void {
    this.failures += 1;
    if (this.failures > 1) return;
    this.log.warn('the waiting line could not be drawn', {
      threadId: this.threadId,
      error: plain(error),
    });
  }
}
