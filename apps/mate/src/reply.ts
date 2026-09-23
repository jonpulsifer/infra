/**
 * One streamed reply: what the answer says and when it is repainted, with a
 * status line naming the current tool call until the turn ends. How
 * any of that reaches a human — and whatever else the surface draws around a
 * turn in flight — is the `Canvas`'s; this holds only the parts that are the
 * same wherever mate answers.
 *
 * A harness writes a turn as runs of text with tool calls between them, and
 * only the last of those runs is an answer: the rest are the agent saying
 * what it is about to do. They are cut apart here rather than left to the
 * surfaces, because both of them need the same cut and neither can take text
 * back once it is out — Slack's stream only ever appends.
 */
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';
import type { PromptSink, Update } from './sandbox.ts';
import type { Canvas, Outcome, ToolCall } from './surface.ts';

export const STATUS_MAX = 120;
export const EDIT_CADENCE_MS = 1_000;
export const NO_REPLY = '(no reply)';
const WORKING_INTERVAL_MS = 8_000;
/**
 * Marks a turn the human stopped, on a surface that writes it into the answer;
 * a turn stopped before any text is only this. The outcome reaches every
 * canvas, and Discord says it in the footer instead.
 */
export const STOPPED = '*stopped*';
/**
 * How long one run of text may keep arriving before it stops being a step and
 * becomes the answer. The cut is retroactive — a run is a step because a tool
 * call came after it — and nothing says in advance which run is the last one,
 * so a run held for the whole of its arrival is a run that cannot stream. A
 * turn that ends in prose is therefore answered all at once, which for the
 * one-sentence "I'll check X" this exists to catch is right and for a page of
 * findings is a wait with nothing moving.
 *
 * Past this, the run is called the answer and streams from there. The cost of
 * being wrong is one stray paragraph above the answer, which is what every
 * turn looked like before any of this; the gain is that a long answer is read
 * as it is written. It also bounds what a step can be: a step is a run that
 * arrived in under this, so the status line below never has to show more than
 * a few seconds' worth of tokens.
 */
export const RUN_GRACE_MS = 3_000;

/** One line of at most `max` characters, with no bold or italics left. */
export function oneLine(line: string, max = STATUS_MAX): string {
  const flat = line.replace(/\s+/g, ' ').trim().replaceAll('*', '');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
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
  /** The answer: the runs of text that no tool call came after. */
  private answer = '';
  /** The run of text in flight, which is a step until something says it is not. */
  private run = '';
  private runAt = 0;
  /** Set once the run in flight has outlasted the grace and become the answer. */
  private answering = false;
  /** The run in flight as the status line shows it, and the last one cut off. */
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
      this.cut();
      this.paintTool(update.call);
      return;
    }
    if (update.kind === 'text') this.take(update.delta);
    else this.status = update.line;
    this.dirty = true;
    this.schedule();
  }

  /**
   * One delta of text. It joins the answer only once the run it belongs to
   * has outlasted the grace; until then it is a step in the making, shown on
   * the status line and nowhere the turn will keep it.
   */
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

  /**
   * A tool call ends the run of text in front of it, which makes that run a
   * step: what the harness said it was about to do, not a part of the answer.
   * A canvas that draws steps gets it; every surface gets it on the status
   * line already, for as long as it was the run in flight.
   */
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
      .then(() => this.repaint())
      .catch((error) => this.cardFailed('tool', error));
  }

  /**
   * A card landed, so the live frame is due again on the cadence: a canvas
   * that lists calls on the frame has nothing else to redraw it, and one that
   * streams only the answer finds nothing new to send. It is asked for once
   * the card is in rather than when the call arrives, because a flush queued
   * between the two would clear the frame's dirt before the card it was for.
   */
  private repaint(): void {
    if (this.outcome) return;
    this.dirty = true;
    this.schedule();
  }

  /** A card that cannot be painted is one warning; the answer is the turn. */
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
    // Nothing came after the run in flight, so it is the answer. A turn that
    // ended on a tool call has no such run, and the last thing it did say is
    // worth more to the thread than "the harness sent no reply".
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
    if (final) await this.canvas.final(this.answer, final);
    // The harness's own status wins while it has one: a tool is running and
    // what it is beats whatever the agent last said it was about to do. The
    // run in flight is what fills the line the rest of the time, which is
    // every moment a turn spends writing rather than running something.
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
