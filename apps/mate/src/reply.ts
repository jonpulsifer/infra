/**
 * One streamed reply: a message edited in place as text arrives, sealed into
 * a new message at the cap, with an italic status line above the live text
 * and a Stop button below it until the turn ends.
 */
import type { Clock, Handle } from './clock.ts';
import { type Discord, type OutMessage, stopRow } from './discord.ts';
import { type Log, plain } from './log.ts';
import type { PromptSink, Update } from './sandbox.ts';

export const MESSAGE_CAP = 2000;
export const STATUS_MAX = 120;
/** Room kept on the live message for the status line and its separator. */
export const STATUS_RESERVE = STATUS_MAX + 6;
export const CHUNK_BUDGET = MESSAGE_CAP - STATUS_RESERVE;
export const EDIT_CADENCE_MS = 1_000;
export const NO_REPLY = 'the harness sent no reply';
const TYPING_INTERVAL_MS = 8_000;
export const PLACEHOLDER = '…';

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

export type Outcome = 'done' | 'stopped' | 'failed';

export class Reply implements PromptSink {
  private text = '';
  private status: string | null = null;
  private sealedLength = 0;
  private liveId: string | null = null;
  private dirty = false;
  private timer: Handle | null = null;
  private typingTimer: Handle | null = null;
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private chain: Promise<void> = Promise.resolve();
  private outcome: Outcome | null = null;
  private failures = 0;

  constructor(
    private readonly discord: Discord,
    private readonly clock: Clock,
    private readonly log: Log,
    private readonly threadId: string,
    private readonly cadenceMs = EDIT_CADENCE_MS,
  ) {}

  /** Shows "typing" until the first visible edit lands. */
  startTyping(): void {
    const tick = () => {
      if (this.liveId || this.outcome) return;
      void this.discord.showTyping(this.threadId).catch(() => {});
      this.typingTimer = this.clock.after(TYPING_INTERVAL_MS, tick);
    };
    tick();
  }

  update(update: Update): void {
    if (this.outcome) return;
    if (update.kind === 'text') this.text += update.delta;
    else this.status = update.line;
    this.dirty = true;
    this.schedule();
  }

  /**
   * Sends the final state. Rejects only when that last send fails; a failed
   * edit mid-stream is logged once and re-sent by the next flush.
   */
  async finish(outcome: Outcome): Promise<void> {
    if (this.outcome) return;
    this.outcome = outcome;
    this.stopTimers();
    this.status = null;
    this.dirty = true;
    if (outcome === 'stopped')
      this.text += `${this.text ? '\n\n' : ''}*stopped*`;
    this.chain = this.chain.then(() => this.flush(true));
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
      .then(() => this.flush(false))
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

  private async flush(final: boolean): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastFlushAt = this.clock.now();
    this.stopTyping();

    let live = this.text.slice(this.sealedLength);
    while (live.length > CHUNK_BUDGET) {
      const [head, rest] = splitAt(live, CHUNK_BUDGET);
      await this.send({ content: head }, true);
      this.liveId = null;
      this.sealedLength += head.length;
      live = rest;
    }

    if (final) {
      if (!live && !this.liveId && this.outcome === 'failed') return;
      await this.send({ content: live || NO_REPLY }, false);
      return;
    }
    const header = this.status ? statusLine(this.status) : '';
    const content = [header, live].filter(Boolean).join('\n\n') || PLACEHOLDER;
    await this.send({ content, components: [stopRow(this.threadId)] }, false);
  }

  private async send(body: OutMessage, seal: boolean): Promise<void> {
    if (this.liveId) {
      await this.discord.editMessage(this.threadId, this.liveId, body);
    } else if (!seal || body.content) {
      this.liveId = await this.discord.createMessage(this.threadId, body);
    }
  }

  private stopTimers(): void {
    if (this.timer) this.clock.cancel(this.timer);
    this.timer = null;
    this.stopTyping();
  }

  private stopTyping(): void {
    if (this.typingTimer) this.clock.cancel(this.typingTimer);
    this.typingTimer = null;
  }
}
