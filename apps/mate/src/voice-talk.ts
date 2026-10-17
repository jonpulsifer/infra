/**
 * One spoken conversation when the bridge hears and speaks itself: the
 * owner's committed transcripts come in over the link, the voice lane
 * answers, and the reply streams back as `speak` frames for the bridge's
 * mouth. A new transcript aborts the reply in progress; a barge-in aborts it
 * and keeps only what the owner heard. Logs carry counts, never words.
 */
import { type Log, plain } from './log.ts';
import { SORRY, type Turn, type VoiceLane } from './speech-engine.ts';
import type { VoiceTool } from './voice-tools.ts';

/** Turns kept as the lane's context; older ones fall off. */
export const TURN_CAP = 40;

export interface TalkOptions {
  /** Names the call on each model request, as a thread's session id does. */
  callId: string;
  lane: VoiceLane | null;
  log: Log;
  /** A `speak` frame for the bridge: a delta, then an empty final. */
  speak(text: string, final: boolean): void;
  /** A whole line for the bridge to voice outside a reply. */
  announce?(text: string): void;
  /** Each committed line of the call, for the call's thread; `who` names a speaker other than the owner. */
  transcript?(role: 'user' | 'agent', text: string, who?: string): void;
  /** A line about the channel for the lane, before the owner's latest words; null for nothing to say. */
  context?(): string | null;
  /** The call's tools, offered on the owner's turns alone. */
  tools?: readonly VoiceTool[];
}

/** Who said a line: the owner, or someone else by name. */
export interface Speaker {
  id: string;
  name: string;
  owner: boolean;
}

const OWNER: Speaker = { id: '', name: 'the owner', owner: true };

interface Run {
  abort: AbortController;
  /** What the lane has said so far, for the transcript when it is cut short. */
  said: string;
}

export interface TalkCounts {
  turns: number;
  replies: number;
  interrupted: number;
  bargeIns: number;
  failed: number;
  heardChars: number;
}

export class Talk {
  private readonly turns: Turn[] = [];
  private current: Run | null = null;
  private stopped = false;
  /** The owner's last committed words, for the confirmation gate. */
  lastHeard = '';
  /** Whether the latest words were the owner's; tools go to those turns alone. */
  private ownerTurn = true;
  readonly counts: TalkCounts = {
    turns: 0,
    replies: 0,
    interrupted: 0,
    bargeIns: 0,
    failed: 0,
    heardChars: 0,
  };

  constructor(private readonly options: TalkOptions) {}

  /** The owner's words; only a committed transcript starts a reply. */
  heard(text: string, final: boolean, speaker: Speaker = OWNER): void {
    if (this.stopped) return;
    this.counts.heardChars += text.length;
    if (!final) return;
    const words = text.trim();
    if (!words) return;
    this.ownerTurn = speaker.owner;
    if (speaker.owner) this.lastHeard = words;
    this.cut('interrupted');
    this.push({
      role: 'user',
      content: speaker.owner ? words : `${speaker.name}: ${words}`,
    });
    this.options.transcript?.(
      'user',
      words,
      speaker.owner ? undefined : speaker.name,
    );
    this.counts.turns += 1;
    const run: Run = { abort: new AbortController(), said: '' };
    this.current = run;
    void this.reply(run);
  }

  /** The owner spoke over the reply, which the bridge has hushed; `heardChars` of it were voiced. */
  bargeIn(heardChars: number): void {
    this.counts.bargeIns += 1;
    this.cut('barge_in', heardChars);
  }

  stop(): void {
    this.stopped = true;
    this.cut('stopped');
  }

  /**
   * Work started from the call settled: the lane sums its result up in a
   * sentence, voiced as an announcement. Nothing plays while a reply is under
   * way; the next reply carries the news instead.
   */
  async announce(task: string, result: string | null): Promise<void> {
    const { lane, log } = this.options;
    if (this.stopped || !this.options.announce) return;
    const news = result
      ? `The task "${task}" finished. Its last message was: ${result.slice(0, 1_500)}`
      : `The task "${task}" finished; its thread has the details.`;
    this.turns.push({ role: 'user', content: `[task result] ${news}` });
    if (this.current || !lane) return;
    const run: Run = { abort: new AbortController(), said: '' };
    this.current = run;
    try {
      for await (const delta of lane.reply(
        [
          ...this.turns,
          {
            role: 'user',
            content:
              'Tell me the result in one short spoken sentence, as an aside.',
          },
        ],
        run.abort.signal,
        this.options.callId,
        [],
        { fillers: false },
      )) {
        if (this.current !== run) return;
        run.said += delta;
      }
      if (this.current !== run) return;
      this.current = null;
      if (run.said.trim()) {
        this.options.announce(run.said.trim());
        this.push({ role: 'agent', content: run.said.trim() });
        log.info('voice talk: announced', { chars: run.said.length });
      }
    } catch (error) {
      if (this.current === run) this.current = null;
      log.warn('voice talk: the announcement failed', { error: plain(error) });
    }
  }

  private async reply(run: Run): Promise<void> {
    const { lane, log, speak } = this.options;
    const live = () => this.current === run && !run.abort.signal.aborted;
    if (!lane) {
      log.warn('voice talk: no voice lane; apologising');
      this.counts.failed += 1;
      this.finish(run, SORRY);
      return;
    }
    try {
      // Anyone may talk to mate; only the owner's words reach a tool.
      const tools = this.ownerTurn ? (this.options.tools ?? []) : [];
      const note = this.options.context?.() ?? null;
      const last = this.turns.at(-1);
      const turns: Turn[] =
        note && last
          ? [...this.turns.slice(0, -1), { role: 'user', content: note }, last]
          : this.turns;
      for await (const delta of lane.reply(
        turns,
        run.abort.signal,
        this.options.callId,
        tools,
      )) {
        if (!live()) return;
        run.said += delta;
        speak(delta, false);
      }
      if (!live()) return;
      this.finish(run, null);
      this.counts.replies += 1;
      log.info('voice talk: replied', {
        chars: run.said.length,
        turns: this.turns.length,
      });
    } catch (error) {
      if (!live()) return;
      this.counts.failed += 1;
      log.warn('voice talk: the voice lane failed', {
        error: plain(error),
        chars: run.said.length,
      });
      this.finish(run, SORRY);
    }
  }

  /** Ends the run's speech: with `line`, says it in place of what was coming. */
  private finish(run: Run, line: string | null): void {
    if (line) {
      run.said += line;
      this.options.speak(line, false);
    }
    this.options.speak('', true);
    this.push({ role: 'agent', content: run.said });
    if (this.current === run) this.current = null;
  }

  /** Aborts the reply in progress and records the part of it that was voiced. */
  private cut(
    why: 'interrupted' | 'barge_in' | 'stopped',
    heardChars?: number,
  ): void {
    const run = this.current;
    if (!run) return;
    this.current = null;
    run.abort.abort();
    if (why === 'interrupted') this.counts.interrupted += 1;
    const heard =
      heardChars === undefined
        ? run.said
        : run.said.slice(0, Math.max(0, Math.min(heardChars, run.said.length)));
    if (heard.trim()) this.push({ role: 'agent', content: heard });
    if (why !== 'stopped') this.options.speak('', true);
  }

  private push(turn: Turn): void {
    if (turn.role === 'agent' && turn.content.trim())
      this.options.transcript?.('agent', turn.content.trim());
    this.turns.push(turn);
    if (this.turns.length > TURN_CAP)
      this.turns.splice(0, this.turns.length - TURN_CAP);
  }
}
