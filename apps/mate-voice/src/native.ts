/**
 * Speech the bridge does itself: Scribe for the owner's words, text-to-speech
 * for mate's, and the floor between them. The owner speaking over mate is a
 * barge-in: the mouth is hushed and mate is told how much was voiced. Words
 * that are mostly mate's own recent words are taken for echo through the
 * owner's speakers and dropped. Logs carry counts, never words.
 */
import type { Log } from './log.ts';
import type { Mouth } from './mouth.ts';
import type { ScribeEars } from './scribe.ts';

/** How long mate's words count as echo after they are voiced. */
export const ECHO_WINDOW_MS = 8_000;
/** The share of a transcript's words found in mate's recent words that makes it echo. */
export const ECHO_SHARE = 0.8;

export interface NativeSpeechOptions {
  ears: (handlers: {
    onPartial(text: string): void;
    onCommitted(text: string): void;
    onEnd(reason: string): void;
  }) => ScribeEars;
  mouth: Mouth;
  log: Log;
  now?: () => number;
  /** The owner's words, interim or committed. */
  onTranscript(text: string, final: boolean): void;
  /** The owner spoke over mate; `heardChars` is how much of the reply was voiced. */
  onBargeIn(heardChars: number): void;
  /** The ears ended for good; the call is deaf. */
  onDeaf(reason: string): void;
}

export interface NativeCounts {
  bargeIns: number;
  echoes: number;
}

const WORD = /[a-z0-9']+/g;

export class NativeSpeech {
  private readonly ears: ScribeEars;
  private readonly mouth: Mouth;
  private spoken: { words: Set<string>; at: number }[] = [];
  /** The utterance in progress already caused a barge-in. */
  private bargedIn = false;
  private stopped = false;
  readonly counts: NativeCounts = { bargeIns: 0, echoes: 0 };

  constructor(private readonly options: NativeSpeechOptions) {
    this.mouth = options.mouth;
    this.ears = options.ears({
      onPartial: (text) => this.heard(text, false),
      onCommitted: (text) => this.heard(text, true),
      onEnd: (reason) => {
        if (!this.stopped) options.onDeaf(reason);
      },
    });
  }

  start(): Promise<void> {
    return this.ears.start();
  }

  hear(opus: Buffer): void {
    this.ears.hear(opus);
  }

  say(text: string, final: boolean): void {
    this.remember(text);
    void this.mouth.say(text, final);
  }

  announce(text: string): void {
    this.remember(text);
    void this.mouth.announce(text);
  }

  hush(): void {
    this.mouth.hush();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ears.stop();
    this.mouth.stop();
    this.options.log.info('speech: stopped', { ...this.counts });
  }

  get speaking(): boolean {
    return this.mouth.speaking;
  }

  private heard(text: string, final: boolean): void {
    if (this.isEcho(text)) {
      if (final) this.counts.echoes += 1;
      return;
    }
    if (this.mouth.speaking && !this.bargedIn) {
      this.bargedIn = true;
      this.counts.bargeIns += 1;
      const heardChars = this.mouth.heardChars;
      this.mouth.hush();
      this.options.onBargeIn(heardChars);
    }
    if (final) this.bargedIn = false;
    this.options.onTranscript(text, final);
  }

  private remember(text: string): void {
    const words = new Set(text.toLowerCase().match(WORD) ?? []);
    if (words.size === 0) return;
    const now = (this.options.now ?? Date.now)();
    this.spoken = this.spoken.filter(
      (entry) => now - entry.at < ECHO_WINDOW_MS,
    );
    this.spoken.push({ words, at: now });
  }

  private isEcho(text: string): boolean {
    const now = (this.options.now ?? Date.now)();
    this.spoken = this.spoken.filter(
      (entry) => now - entry.at < ECHO_WINDOW_MS,
    );
    if (this.spoken.length === 0) return false;
    const words = text.toLowerCase().match(WORD) ?? [];
    if (words.length === 0) return false;
    let found = 0;
    for (const word of words) {
      if (this.spoken.some((entry) => entry.words.has(word))) found += 1;
    }
    // A word or two is echo only when every word is mate's.
    const share = found / words.length;
    return words.length < 3 ? share === 1 : share >= ECHO_SHARE;
  }
}
