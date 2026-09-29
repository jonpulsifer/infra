/**
 * The port the thread engine drives: open a thread's durable session, run a
 * turn in it, resume one a restart cut off, stop one, and put a thread away.
 */
import type { TeardownReason } from './lease.ts';
import type { PromptResult, PromptSink } from './sandbox.ts';
import type { MessageRef, ThreadRef } from './surface.ts';
import type { ThreadRow } from './thread-store.ts';

/** A run the store still holds open: mate stopped while it was in flight. */
export interface InterruptedRun {
  readonly operationId: string;
  readonly startedAt: number;
}

export interface BrainSession {
  /** `threadKey(ref)`; the pi session id is the row's `sessionId`. */
  readonly key: string;
  readonly ref: ThreadRef;
  /** The store already held this thread's messages; false means replay the transcript. */
  readonly resumed: boolean;
  /** Set once, at open; the caller resumes or discards it before any prompt. */
  readonly interrupted: InterruptedRun | null;
}

/** Whom a turn answers: a resume needs both after a restart. */
export interface TurnContext {
  readonly asker: string;
  readonly message: MessageRef;
}

/** The session store cannot be reached, or the session cannot open safely; nothing ran. */
export class BrainUnavailable extends Error {
  override readonly name = 'BrainUnavailable';
}

/**
 * SIGTERM closed the harness under this turn. The run stays open in the store
 * for the next process to resume, so the caller delivers nothing, marks
 * nothing, tells nothing and keeps the thread's turn mark.
 */
export class TurnAbandoned extends Error {
  override readonly name = 'TurnAbandoned';
}

export interface Brain {
  /**
   * Opens the row's session, within a bound. Throws `BrainUnavailable`; a
   * corrupt session is quarantined inside, and a fresh one opens.
   */
  open(row: ThreadRow): Promise<BrainSession>;
  /** Throws only `BrainUnavailable` or `TurnAbandoned`; every other failure is an `error` result. */
  prompt(
    session: BrainSession,
    text: string,
    sink: PromptSink,
    turn: TurnContext,
  ): Promise<PromptResult>;
  /** Drives `session.interrupted` to its end into `sink`. Throws as `prompt` does. */
  resume(
    session: BrainSession,
    sink: PromptSink,
    turn: TurnContext,
  ): Promise<PromptResult>;
  /** Aborts `session.interrupted` durably. Never throws. */
  discard(session: BrainSession): Promise<void>;
  /** Stop: aborts the running turn, or the next one to start. Never throws. */
  cancel(session: BrainSession): Promise<void>;
  /** Closes the harness and gives the sandbox back; the stored session stays. Never throws. */
  release(ref: ThreadRef, reason: TeardownReason): Promise<void>;
  /**
   * A deleted thread: once an open of it already under way settles, release
   * it, then delete every stored session its row names. Never throws.
   */
  forget(ref: ThreadRef): Promise<void>;
  /**
   * SIGTERM, once the engine stops waiting for turns: closes the harness under
   * every running turn, whose `prompt` or `resume` then throws `TurnAbandoned`,
   * and then abandons its lease. Bounded; never throws.
   */
  abandon(): Promise<void>;
}
