/**
 * Speech the bridge does itself: Scribe for everyone's words, each person on
 * their own session so the words stay theirs, text-to-speech for mate's, and
 * the floor between them. The owner speaking over mate is a barge-in: the
 * mouth is hushed and mate is told how much was voiced; anyone else talking
 * over mate is just talk. Words that are mostly mate's own recent words are
 * taken for echo through someone's speakers and dropped. A session for
 * someone other than the owner closes after a quiet spell and opens again
 * at their next word. Logs carry counts, never words.
 */
import type { Log } from './log.ts';
import type { Mouth } from './mouth.ts';
import type { ScribeEars } from './scribe.ts';

/** How long mate's words count as echo after they are voiced. */
export const ECHO_WINDOW_MS = 8_000;
/** The share of a transcript's words found in mate's recent words that makes it echo. */
export const ECHO_SHARE = 0.8;
/** Quiet after which a session for someone other than the owner closes. */
export const OTHERS_IDLE_MS = 60_000;

export interface EarsHandlers {
  onPartial(text: string): void;
  onCommitted(text: string): void;
  onEnd(reason: string): void;
}

export interface NativeSpeechOptions {
  ownerId: string;
  /** One Scribe session; `idleMs` set means it may close when quiet. */
  ears: (userId: string, handlers: EarsHandlers, idleMs?: number) => ScribeEars;
  mouth: Mouth;
  log: Log;
  now?: () => number;
  /** Someone's words, interim or committed. */
  onTranscript(userId: string, text: string, final: boolean): void;
  /** The owner spoke over mate; `heardChars` is how much of the reply was voiced. */
  onBargeIn(heardChars: number): void;
  /** The owner's ears ended for good; the call is deaf to the owner. */
  onDeaf(reason: string): void;
}

export interface NativeCounts {
  bargeIns: number;
  echoes: number;
  /** Sessions opened for people other than the owner. */
  others: number;
}

const WORD = /[a-z0-9']+/g;

export class NativeSpeech {
  private readonly ears = new Map<string, ScribeEars>();
  private readonly mouth: Mouth;
  private spoken: { words: Set<string>; at: number }[] = [];
  /** The utterance in progress already caused a barge-in. */
  private bargedIn = false;
  private stopped = false;
  readonly counts: NativeCounts = { bargeIns: 0, echoes: 0, others: 0 };

  constructor(private readonly options: NativeSpeechOptions) {
    this.mouth = options.mouth;
  }

  /** Opens the owner's ears; anyone else's open at their first frame. */
  start(): Promise<void> {
    return this.earsFor(this.options.ownerId).start();
  }

  hear(userId: string, opus: Buffer): void {
    if (this.stopped) return;
    const known = this.ears.get(userId);
    if (known) {
      known.hear(opus);
      return;
    }
    const ears = this.earsFor(userId);
    void ears.start();
    ears.hear(opus);
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
    for (const ears of this.ears.values()) ears.stop();
    this.ears.clear();
    this.mouth.stop();
    this.options.log.info('speech: stopped', { ...this.counts });
  }

  get speaking(): boolean {
    return this.mouth.speaking;
  }

  private earsFor(userId: string): ScribeEars {
    const owner = userId === this.options.ownerId;
    if (!owner) this.counts.others += 1;
    const ears = this.options.ears(
      userId,
      {
        onPartial: (text) => this.heard(userId, text, false),
        onCommitted: (text) => this.heard(userId, text, true),
        onEnd: (reason) => {
          if (this.ears.get(userId) === ears) this.ears.delete(userId);
          if (owner && !this.stopped && reason !== 'idle') {
            this.options.onDeaf(reason);
          }
        },
      },
      owner ? undefined : OTHERS_IDLE_MS,
    );
    this.ears.set(userId, ears);
    return ears;
  }

  private heard(userId: string, text: string, final: boolean): void {
    if (this.isEcho(text)) {
      if (final) this.counts.echoes += 1;
      return;
    }
    if (userId === this.options.ownerId) {
      if (this.mouth.speaking && !this.bargedIn) {
        this.bargedIn = true;
        this.counts.bargeIns += 1;
        const heardChars = this.mouth.heardChars;
        this.mouth.hush();
        this.options.onBargeIn(heardChars);
      }
      if (final) this.bargedIn = false;
    }
    this.options.onTranscript(userId, text, final);
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
