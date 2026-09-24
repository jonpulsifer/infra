/**
 * One streamed reply. A run of text followed by a tool call is a step and stays
 * out of the answer; the cut is made here because Slack's stream only appends.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import type { PromptSink, Update } from './sandbox.ts';
import type { Canvas, Outcome, ToolCall } from './surface.ts';

export const STATUS_MAX = 120;
export const EDIT_CADENCE_MS = 1_000;
export const NO_REPLY = '(no reply)';
const WORKING_INTERVAL_MS = 8_000;
/** Written into the answer by a surface with no footer to say it in. */
export const STOPPED = '*stopped*';
// A run still arriving after this is taken as the answer and streams. A wrong
// guess costs one stray paragraph above the answer.
export const RUN_GRACE_MS = 3_000;

export function oneLine(line: string, max = STATUS_MAX): string {
  const flat = line.replace(/\s+/g, ' ').trim().replaceAll('*', '');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function splitAt(text: string, budget: number): [string, string] {
  if (text.length <= budget) return [text, ''];
  const window = text.slice(0, budget);
  const cut = window.lastIndexOf('\n');
  const at = cut > budget / 2 ? cut + 1 : budget;
  return [text.slice(0, at), text.slice(at)];
}

export type { Outcome };

export class Reply implements PromptSink {
  private answer = '';
  private run = '';
  private runAt = 0;
  private answering = false;
  private runLine: string | null = null;
  private lastStep: string | null = null;
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
    private readonly graceMs = RUN_GRACE_MS,
  ) {}

  /** Shows the surface's "working" sign until the first visible frame is sent. */
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
      this.cut();
      this.paintTool(update.call);
      return;
    }
    if (update.kind === 'text') this.take(update.delta);
    else this.status = update.line;
    this.dirty = true;
    this.schedule();
  }

  private take(delta: string): void {
    if (this.answering) {
      this.answer += delta;
      return;
    }
    if (!this.run) this.runAt = this.clock.now();
    this.run += delta;
    if (this.clock.now() - this.runAt >= this.graceMs) {
      this.answer += this.run;
      this.run = '';
      this.runLine = null;
      this.answering = true;
      return;
    }
    this.runLine = this.run;
  }

  private cut(): void {
    this.runLine = null;
    this.answering = false;
    const step = this.run.trim();
    this.run = '';
    if (!step) return;
    this.lastStep = step;
    const paint = this.canvas.step;
    if (!paint) return;
    this.chain = this.chain
      .then(() => paint.call(this.canvas, step))
      .catch((error) => this.cardFailed('step', error));
  }

  // Skips the repaint cadence, since tool calls arrive slowly, but queues
  // behind frames in flight so the surface keeps their order.
  private paintTool(call: ToolCall): void {
    const paint = this.canvas.tool;
    if (!paint) return;
    this.chain = this.chain
      .then(() => paint.call(this.canvas, call))
      .then(() => this.repaint())
      .catch((error) => this.cardFailed('tool', error));
  }

  // Called once the card is sent: a flush queued earlier would clear the
  // dirty flag before the card it was for.
  private repaint(): void {
    if (this.outcome) return;
    this.dirty = true;
    this.schedule();
  }

  private cardFailed(what: string, error: unknown): void {
    this.cardFailures += 1;
    if (this.cardFailures > 1) return;
    this.log.warn(`a ${what} card could not be painted`, {
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
    // The run in flight is the answer. A turn that ended on a tool call
    // answers with its last step.
    this.answer += this.run;
    this.run = '';
    if (!this.answer && this.lastStep) this.answer = this.lastStep;
    this.status = null;
    this.runLine = null;
    this.dirty = true;
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
    // Nothing goes out after the final frame: a repaint queued before `finish`
    // would reopen the stream and bring Stop back.
    if (!final && (this.outcome || !this.dirty)) return;
    this.dirty = false;
    this.painted = true;
    this.lastFlushAt = this.clock.now();
    this.stopWorking();
    if (final) await this.canvas.final(this.answer, final);
    // The harness status, a running tool, wins over the run in flight.
    else await this.canvas.live(this.answer, this.status ?? this.runLine);
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
