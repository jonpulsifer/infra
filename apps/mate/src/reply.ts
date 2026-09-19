/**
 * One streamed reply: what the answer says and when it is repainted, with an
 * italic status line naming the current tool call until the turn ends. How
 * any of that reaches a human — and whatever else the surface draws around a
 * turn in flight — is the `Canvas`'s; this holds only the parts that are the
 * same wherever mate answers.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import type { PromptSink, Update } from './sandbox.ts';
import type { Canvas, Outcome, ToolCall } from './surface.ts';

export const STATUS_MAX = 120;
export const EDIT_CADENCE_MS = 1_000;
export const NO_REPLY = 'the harness sent no reply';
const WORKING_INTERVAL_MS = 8_000;
export const PLACEHOLDER = '…';
/** Marks a turn the human stopped; a turn stopped before any text is only this. */
export const STOPPED = '*stopped*';

export function statusLine(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim().replaceAll('*', '');
  const cut =
    flat.length > STATUS_MAX ? `${flat.slice(0, STATUS_MAX - 1)}…` : flat;
  return `*${cut}*`;
}

/** Splits `text` so the head fits `budget`, preferring the last line break. */
export function splitAt(text: string, budget: number): [string, string] {
  if (text.length <= budget) return [text, ''];
  const window = text.slice(0, budget);
  const cut = window.lastIndexOf('\n');
  const at = cut > budget / 2 ? cut + 1 : budget;
  return [text.slice(0, at), text.slice(at)];
}

export type { Outcome };

export class Reply implements PromptSink {
  private text = '';
  private status: string | null = null;
  private dirty = false;
  private painted = false;
  private timer: Handle | null = null;
  private workingTimer: Handle | null = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private outcome: Outcome | null = null;
  private failures = 0;
  private cardFailures = 0;

  constructor(
    private readonly canvas: Canvas,
    private readonly clock: Clock,
    private readonly log: Log,
    private readonly threadId: string,
    private readonly cadenceMs = EDIT_CADENCE_MS,
  ) {}

  /** Shows the surface's "working" sign until the first visible frame lands. */
  startWorking(): void {
    if (!this.canvas.working) return;
    const tick = () => {
      if (this.painted || this.outcome) return;
      void this.canvas.working?.().catch(() => {});
      this.workingTimer = this.clock.after(WORKING_INTERVAL_MS, tick);
    };
    tick();
  }

  update(update: Update): void {
    if (this.outcome) return;
    if (update.kind === 'tool') {
      this.paintTool(update.call);
      return;
    }
    if (update.kind === 'text') this.text += update.delta;
    else this.status = update.line;
    this.dirty = true;
    this.schedule();
  }

  /**
   * A tool call goes straight to the canvas rather than waiting for the
   * repaint cadence: it is one small call arriving at tool-call rate, not at
   * token rate, and it is queued behind the frames already in flight so a
   * surface that interleaves the two shows them in the order they happened.
   * A canvas with no cards has nothing to do here.
   */
  private paintTool(call: ToolCall): void {
    const paint = this.canvas.tool;
    if (!paint) return;
    this.chain = this.chain
      .then(() => paint.call(this.canvas, call))
      .catch((error) => this.cardFailed(error));
  }

  /** A card that cannot be painted is one warning; the answer is the turn. */
  private cardFailed(error: unknown): void {
    this.cardFailures += 1;
    if (this.cardFailures > 1) return;
    this.log.warn('a tool card could not be painted', {
      threadId: this.threadId,
      error: plain(error),
    });
  }

  /**
   * Sends the final state. Rejects only when that last send fails; a failed
   * repaint mid-stream is logged once and re-sent by the next flush.
   */
  async finish(outcome: Outcome): Promise<void> {
    if (this.outcome) return;
    this.outcome = outcome;
    this.stopTimers();
    this.status = null;
    this.dirty = true;
    if (outcome === 'stopped')
      this.text += `${this.text ? '\n\n' : ''}${STOPPED}`;
    this.chain = this.chain.then(() => this.flush(outcome));
    await this.chain;
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = this.cadenceMs - (this.clock.now() - this.lastFlushAt);
    if (wait <= 0) {
      this.enqueue();
      return;
    }
    this.timer = this.clock.after(wait, () => {
      this.timer = null;
      this.enqueue();
    });
  }

  private enqueue(): void {
    this.chain = this.chain
      .then(() => this.flush(null))
      .catch((error) => this.failed(error));
  }

  private failed(error: unknown): void {
    this.dirty = true;
    this.failures += 1;
    if (this.failures === 1) {
      this.log.warn('reply edit failed; the next flush re-sends', {
        threadId: this.threadId,
        error: plain(error),
      });
    }
  }

  private async flush(final: Outcome | null): Promise<void> {
    // The last frame always goes out, and nothing goes out after it. A turn
    // whose updates all land in one tick queues a repaint per update, and
    // one of those would otherwise run after `finish` and paint the finished
    // answer as a live frame — leaving the stream open and the Stop button
    // up, with the frame that takes them away skipped as a no-op.
    if (!final && (this.outcome || !this.dirty)) return;
    this.dirty = false;
    this.painted = true;
    this.lastFlushAt = this.clock.now();
    this.stopWorking();
    if (final) await this.canvas.final(this.text, final);
    else await this.canvas.live(this.text, this.status);
  }

  private stopTimers(): void {
    if (this.timer) this.clock.cancel(this.timer);
    this.timer = null;
    this.stopWorking();
  }

  private stopWorking(): void {
    if (this.workingTimer) this.clock.cancel(this.workingTimer);
    this.workingTimer = null;
  }
}
