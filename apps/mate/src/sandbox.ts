/**
 * What a turn streams to a surface, and `StubBrain`: an in-process brain for
 * `MATE_SANDBOXES=stub` and the thread tests. It runs scripts instead of a
 * model and keeps its sessions in memory.
 */
import {
  type Brain,
  type BrainSession,
  BrainUnavailable,
  type InterruptedRun,
  TurnAbandoned,
  type TurnContext,
} from './brain-port.ts';
import { type Clock, systemClock } from './clock.ts';
import type { MintStep, SandboxSource, TeardownReason } from './lease.ts';
import { type ThreadRef, type ToolCall, threadKey } from './surface.ts';
import type { ThreadRow } from './thread-store.ts';
import { SandboxCard } from './turn.ts';

// `status` and `tool` carry the same news two ways; each surface shows the
// one it can.
export type Update =
  | { kind: 'text'; delta: string }
  | { kind: 'status'; line: string | null }
  | { kind: 'tool'; call: ToolCall };

export interface PromptSink {
  update(update: Update): void;
}

export type StopReason = 'end_turn' | 'cancelled' | 'error';

export interface PromptResult {
  stopReason: StopReason;
  error?: string;
  /** Milliseconds from the prompt to the first streamed text, when any arrived. */
  firstTokenMs?: number | null;
  /** pi's catalog price, summed over the run, in USD. */
  costUsd?: number | null;
  /** The brain set the thread's memory aside; the next prompt carries the transcript. */
  reset?: boolean;
}

export type Step =
  | { text: string }
  | { status: string | null }
  | { tool: ToolCall }
  | { wait: number }
  /** Holds the run until the promise settles, so a test can pause it. */
  | { until: Promise<unknown> }
  | { fail: string }
  /** The brain's store failed under the turn. */
  | { throw: string }
  /** A tool call leasing the sandbox, drawn as the brain draws it. */
  | { mint: SandboxSource | 'fail' };

export type Script = (prompt: string) => Step[];

export const echoScript: Script = (prompt) => {
  const words = prompt.split(/\s+/).filter(Boolean);
  const steps: Step[] = [{ status: 'running `echo`…' }, { wait: 300 }];
  steps.push({ text: 'you said: ' });
  for (const word of words) steps.push({ text: `${word} ` }, { wait: 120 });
  steps.push({ status: null });
  return steps;
};

const MINT_EVENTS: Record<SandboxSource, MintStep[]> = {
  fresh: ['creating', 'booting'],
  spare: ['adopting', 'refreshing'],
  reused: ['reusing'],
};

interface StoredSession {
  messages: number;
  interrupted: InterruptedRun | null;
}

interface Run {
  readonly key: string;
  /** Abandoned at shutdown. */
  readonly abort: AbortController;
  /** Stopped by a human. */
  readonly stop: AbortController;
}

export interface StubOptions {
  clock?: Clock;
  script?: Script;
  /** What a resumed run says; `[{ text: 'resumed' }]` unless given. */
  resumeScript?: Script;
  costUsd?: number;
}

export class StubBrain implements Brain {
  private readonly clock: Clock;
  private readonly script: Script;
  private readonly resumeScript: Script;
  /** Outlives any one engine, so a second one on the same brain is a restart. */
  private readonly sessions = new Map<string, StoredSession>();
  private readonly running = new Map<string, Run>();
  private serial = 0;
  /** Set by `abandon`: like PiBrain, this brain runs no turn after SIGTERM. */
  private shutDown = false;
  /** While set, every open throws `BrainUnavailable` with it. */
  openFails: string | null = null;
  /** The next open sets the stored session aside and starts a fresh one. */
  corrupt = false;
  /**
   * The next prompt finds the session set aside after repeated faults, as
   * PiBrain reports it: an error result with `reset`, and an empty session.
   */
  setAside = false;
  /** Every prompt text the brain was handed, replay preamble included. */
  readonly prompts: string[] = [];
  readonly resumes: { key: string; asker: string }[] = [];
  readonly discarded: string[] = [];
  readonly released: { key: string; reason: TeardownReason }[] = [];
  readonly forgotten: string[] = [];
  readonly quarantined: string[] = [];
  /** Sandbox acquisitions, one per `mint` step. */
  leases = 0;

  constructor(private readonly opts: StubOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.script = opts.script ?? echoScript;
    this.resumeScript = opts.resumeScript ?? (() => [{ text: 'resumed' }]);
  }

  /** Marks a session as holding a run a dead mate left open. */
  interrupt(key: string, startedAt = this.clock.now()): void {
    this.stored(key).interrupted = {
      operationId: `op-${++this.serial}`,
      startedAt,
    };
  }

  /** Whether a stored session holds messages, as a restart would find it. */
  holds(key: string): boolean {
    return (this.sessions.get(key)?.messages ?? 0) > 0;
  }

  async open(row: ThreadRow): Promise<BrainSession> {
    if (this.openFails) throw new BrainUnavailable(this.openFails);
    if (this.corrupt) {
      this.corrupt = false;
      this.quarantined.push(row.sessionId);
      this.sessions.delete(row.sessionId);
    }
    const stored = this.stored(row.sessionId);
    return {
      key: row.key,
      ref: row.ref,
      resumed: stored.messages > 0,
      interrupted: stored.interrupted,
    };
  }

  prompt(
    session: BrainSession,
    text: string,
    sink: PromptSink,
    _turn: TurnContext,
  ): Promise<PromptResult> {
    this.prompts.push(text);
    if (this.shutDown) return Promise.reject(shuttingDown());
    if (this.setAside) {
      this.setAside = false;
      this.quarantined.push(session.key);
      this.sessions.delete(session.key);
      return Promise.resolve({
        stopReason: 'error',
        error: "mate set this thread's memory aside",
        reset: true,
      });
    }
    return this.run(session, this.script(text), sink);
  }

  resume(
    session: BrainSession,
    sink: PromptSink,
    turn: TurnContext,
  ): Promise<PromptResult> {
    this.resumes.push({ key: session.key, asker: turn.asker });
    if (this.shutDown) return Promise.reject(shuttingDown());
    return this.run(session, this.resumeScript(''), sink);
  }

  async discard(session: BrainSession): Promise<void> {
    this.discarded.push(session.key);
    this.stored(session.key).interrupted = null;
  }

  async cancel(session: BrainSession): Promise<void> {
    this.running.get(session.key)?.stop.abort();
  }

  async release(ref: ThreadRef, reason: TeardownReason): Promise<void> {
    this.released.push({ key: threadKey(ref), reason });
  }

  async forget(ref: ThreadRef): Promise<void> {
    const key = threadKey(ref);
    this.forgotten.push(key);
    await this.cancel({ key, ref, resumed: false, interrupted: null });
    this.sessions.delete(key);
  }

  /**
   * Every run still going rejects with `TurnAbandoned` and stays open for a
   * resume, and every later prompt or resume is refused the same way.
   */
  async abandon(): Promise<void> {
    this.shutDown = true;
    for (const run of this.running.values()) {
      this.interrupt(run.key);
      run.abort.abort(shuttingDown());
    }
  }

  /** A new mate over the same sessions: turns run again after `abandon`. */
  restart(): void {
    this.shutDown = false;
  }

  private stored(key: string): StoredSession {
    let stored = this.sessions.get(key);
    if (!stored) {
      stored = { messages: 0, interrupted: null };
      this.sessions.set(key, stored);
    }
    return stored;
  }

  private async run(
    session: BrainSession,
    steps: Step[],
    sink: PromptSink,
  ): Promise<PromptResult> {
    const run: Run = {
      key: session.key,
      abort: new AbortController(),
      stop: new AbortController(),
    };
    this.running.set(session.key, run);
    const stored = this.stored(session.key);
    stored.interrupted = null;
    const card = new SandboxCard(
      (call) => sink.update({ kind: 'tool', call }),
      this.clock,
    );
    const startedAt = this.clock.now();
    let firstTokenMs: number | null = null;
    try {
      for (const step of steps) {
        await this.step(step, run, sink, card);
        if ('text' in step) firstTokenMs ??= this.clock.now() - startedAt;
        if ('fail' in step) return { stopReason: 'error', error: step.fail };
      }
      if (run.stop.signal.aborted) return { stopReason: 'cancelled' };
      stored.messages += 1;
      return {
        stopReason: 'end_turn',
        firstTokenMs,
        costUsd: this.opts.costUsd ?? null,
      };
    } catch (error) {
      if (run.abort.signal.aborted) throw run.abort.signal.reason;
      if (run.stop.signal.aborted) return { stopReason: 'cancelled' };
      throw error;
    } finally {
      card.end();
      if (this.running.get(session.key) === run) {
        this.running.delete(session.key);
      }
    }
  }

  private async step(
    step: Step,
    run: Run,
    sink: PromptSink,
    card: SandboxCard,
  ): Promise<void> {
    const signal = AbortSignal.any([run.abort.signal, run.stop.signal]);
    if (signal.aborted) throw signal.reason;
    if ('wait' in step) await this.clock.sleep(step.wait, signal);
    else if ('until' in step) await abortable(step.until, signal);
    else if ('text' in step) sink.update({ kind: 'text', delta: step.text });
    else if ('status' in step)
      sink.update({ kind: 'status', line: step.status });
    else if ('tool' in step) sink.update({ kind: 'tool', call: step.tool });
    else if ('throw' in step) throw new BrainUnavailable(step.throw);
    else if ('mint' in step) this.lease(step.mint, card);
  }

  private lease(source: SandboxSource | 'fail', card: SandboxCard): void {
    this.leases += 1;
    if (source === 'fail') {
      card.event({ kind: 'failed', error: 'no room on the node' });
      return;
    }
    for (const step of MINT_EVENTS[source]) card.event({ kind: 'step', step });
    card.event({ kind: 'connecting' });
    card.event({
      kind: 'ready',
      sandbox: `mate-stub-${this.leases}`,
      source,
    });
  }
}

function shuttingDown(): TurnAbandoned {
  return new TurnAbandoned('mate is shutting down');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
