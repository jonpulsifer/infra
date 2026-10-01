/**
 * The brain: one pi harness per open thread, on lane `main`, in mate's own
 * process, with the prompt, model, tools and turn timeout of the row's
 * profile. The model streams before any sandbox exists; the hands lease one
 * on the first tool call. A run a restart cut off stays open in mate-db and
 * resumes, and a harness that faults is closed, drained and opened again.
 */
import {
  AgentHarness,
  type AgentLane,
  BACKGROUND_CONTEXT,
  type Context,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionToolContext,
  HarnessClosed,
  type HarnessEvent,
  type HarnessEventType,
  HarnessFault,
  type OperationResultRecord,
  type Session,
  SessionInvariantError,
  withCancel,
} from '@earendil-works/pi-agent-core';
import type { RetryPolicy } from '@earendil-works/pi-ai';
import { deleteSession, openSession } from '@repo/pi-store-postgres';
import type { SQL } from 'bun';
import type {
  BrainProfile,
  BridgedTool,
  McpBridge,
  ModelSetup,
} from './brain-inputs.ts';
import {
  type Brain,
  type BrainSession,
  BrainUnavailable,
  type InterruptedRun,
  TurnAbandoned,
  type TurnContext,
} from './brain-port.ts';
import { type Clock, type Handle, systemClock } from './clock.ts';
import type {
  Hands,
  SandboxGoneReason,
  TeardownReason,
  ThreadHands,
  ThreadHandsHooks,
  TurnLease,
} from './lease.ts';
import { type Log, plain } from './log.ts';
import {
  type Instruments,
  lazyInstruments,
  type ProviderErrorKind,
} from './metrics.ts';
import { lists, type Profile, sweepable } from './profiles.ts';
import { redact } from './redact.ts';
import { fallbackError, type RouteEvent } from './route.ts';
import type { PromptResult, PromptSink } from './sandbox.ts';
import { type Database, isStoreUnavailable, storeError } from './store.ts';
import { type ThreadRef, threadKey } from './surface.ts';
import type { ThreadRow, ThreadRowPatch, ThreadStore } from './thread-store.ts';
import { TurnTranslator } from './turn.ts';

/** The model waits seconds before its first event on every step. */
export const PROVIDER_TIMEOUT_MS = 240_000;
export const TIMEOUT_GRACE_MS = 30_000;
/** A run still going this long after Stop is closed under the turn. */
export const STOP_GRACE_MS = 15_000;
export const DISCARD_DEADLINE_MS = 30_000;
export const MCP_BOOT_WAIT_MS = 10_000;
/** Bounds a whole `open`, whatever the store retries. */
export const OPEN_TIMEOUT_MS = 15_000;
/** A closing harness drains its commits in this long, or the thread stays `recovering`. */
export const HARNESS_CLOSE_MS = 10_000;
export const ABANDON_CLOSE_MS = 5_000;
/** Faults in a row before the session is set aside. */
export const FAULT_LIMIT = 2;
/** Quarantines in an hour before the brain stops setting sessions aside. */
export const QUARANTINE_LIMIT = 3;
const QUARANTINE_WINDOW_MS = 3_600_000;
const FORGET_WAIT_MS = 10_000;
const SWEEP_BATCH = 100;
/** How many messages back a resume looks for the calls its run made. */
const RESUME_LOOKBACK = 16;
const LANE = 'main';
const CTX = BACKGROUND_CONTEXT;

export const RECOVERING =
  "mate is still recovering this thread's memory — try again in a minute";
export const SET_ASIDE =
  "mate set this thread's memory aside after repeated faults and starts it afresh — send that again";
/** pi refuses an empty prompt, and a bare mention or an attachment has no text. */
export const NO_TEXT =
  '[mate: this message has no text. mate passes on only the text of a message, not its attachments.]';

const ROUTED: readonly HarnessEventType[] = [
  'message_start',
  'message_update',
  'message_end',
  'tool_start',
  'tool_end',
  'usage',
  'run_end',
  'retry_scheduled',
];

export interface SessionSource {
  open(id: string): Promise<Session>;
  delete(id: string): Promise<void>;
}

export function postgresSessions(sql: SQL): SessionSource {
  return {
    open: (id) => openSession(sql, { id }),
    delete: (id) => deleteSession(sql, id),
  };
}

export interface BrainTimeouts {
  open: number;
  harnessClose: number;
  timeoutGrace: number;
  stopGrace: number;
  discard: number;
  abandonClose: number;
  mcpBootWait: number;
  forgetWait: number;
}

export interface PiBrainDeps {
  db: Pick<Database, 'up'>;
  store: ThreadStore;
  sessions: SessionSource;
  hands: Hands;
  setup: ModelSetup;
  /** By profile id; a row naming an absent one opens nothing. */
  profiles: ReadonlyMap<string, BrainProfile>;
  mcp: McpBridge | null;
  log: Log;
  clock?: Clock;
  metrics?: Instruments;
  /** pi's provider retries; tests shorten the backoff. */
  retry?: RetryPolicy;
  timeouts?: Partial<BrainTimeouts>;
}

interface Turn {
  readonly translator: TurnTranslator;
  /** Aborted when the turn ends: it bounds a wait for a sandbox slot. */
  readonly leaseStop: AbortController;
  lease: TurnLease | null;
  /** Set once the run is admitted; pi's events route here from then on. */
  operationId: string | null;
  cancelRequested: boolean;
  timedOut: boolean;
  /** SIGTERM closed the harness under this turn. */
  abandoned: boolean;
  /** Resolves when a timeout or a Stop gives up waiting for the run to settle. */
  readonly cutOff: Promise<CutOff>;
  cut(why: CutOff): void;
  /** The one timer that arms `cut`, after a timeout or a Stop. */
  grace: Handle | null;
  readonly done: Promise<void>;
  resolve(): void;
}

type CutOff = 'expired' | 'stopped';

interface ThreadBrain {
  readonly key: string;
  readonly ref: ThreadRef;
  readonly hands: ThreadHands;
  row: ThreadRow;
  profile: BrainProfile;
  harness: AgentHarness<ExecutionToolContext>;
  lane: AgentLane;
  unsubscribe: () => void;
  interrupted: InterruptedRun | null;
  resumed: boolean;
  workspaceReset: SandboxGoneReason | null;
  faults: number;
  /** The harness faulted or timed out; the next prompt opens it again. */
  broken: boolean;
  /** The broken harness's close, which drains the commits it admitted. */
  closing: Promise<void> | null;
  closed: boolean;
  /** The MCP listing changed since the lane was reconciled. */
  stale: boolean;
  turn: Turn | null;
}

/** Stands in for a tool a saved run names but the bridge or the profile does not list. */
export function unreachableTool(name: string): BridgedTool {
  return {
    name,
    label: name,
    description: 'A kthx tool. kthx is unreachable right now.',
    parameters: { type: 'object', additionalProperties: true },
    replay: 'never',
    execute: async () => {
      throw new Error('kthx is unreachable');
    },
  };
}

export function resetNote(reason: SandboxGoneReason): string {
  return `[mate: this thread's sandbox was deleted (${reason}) since your last turn. The next tool call starts a fresh checkout at /workspace; uncommitted work from earlier turns is gone.]`;
}

/** A fallback that failed too is judged by its own words, not the router's clause. */
export function providerErrorKind(routed: string): ProviderErrorKind {
  const message = fallbackError(routed) ?? routed;
  if (
    /usage.?limit|available balance|insufficient_quota|quota|billing|budget/i.test(
      message,
    )
  ) {
    return 'limit';
  }
  if (
    /\b40[13]\b|unauthori[sz]ed|forbidden|api.?key|Provider is not configured|signed in to ChatGPT|ChatGPT sign-in/i.test(
      message,
    )
  ) {
    return 'auth';
  }
  if (/timed? ?out|timeout/i.test(message)) return 'timeout';
  return 'other';
}

/**
 * What broke: pi wraps every storage or invariant failure in a `HarnessFault`
 * whose message never changes, and keeps the real error as its cause.
 */
function explain(error: unknown): string {
  const cause =
    error instanceof HarnessFault && error.cause !== undefined
      ? error.cause
      : error;
  return redact(storeError(cause));
}

/** A restored session that breaks pi's own invariants. */
function isCorrupt(error: unknown): boolean {
  const inner = error instanceof HarnessFault ? error.cause : error;
  return (
    inner instanceof SessionInvariantError ||
    error instanceof SessionInvariantError
  );
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sorted = [...b].sort();
  return [...a].sort().every((name, at) => name === sorted[at]);
}

function errorResult(error: string, turn?: Turn): PromptResult {
  return {
    stopReason: 'error',
    error: redact(error),
    firstTokenMs: turn?.translator.firstTokenMs ?? null,
    costUsd: turn?.translator.costUsd ?? null,
  };
}

class ClosedUnderTurn extends Error {
  override readonly name = 'ClosedUnderTurn';
}

export class PiBrain implements Brain {
  private readonly threads = new Map<string, ThreadBrain>();
  private readonly keyLocks = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Set<Promise<void>>>();
  private readonly baseTools: readonly BridgedTool[];
  private readonly clock: Clock;
  private readonly metrics: Instruments;
  private readonly timeouts: BrainTimeouts;
  private quarantines: number[] = [];
  private draining = false;

  constructor(private readonly deps: PiBrainDeps) {
    this.clock = deps.clock ?? systemClock;
    this.metrics = deps.metrics ?? lazyInstruments();
    this.timeouts = {
      open: OPEN_TIMEOUT_MS,
      harnessClose: HARNESS_CLOSE_MS,
      timeoutGrace: TIMEOUT_GRACE_MS,
      stopGrace: STOP_GRACE_MS,
      discard: DISCARD_DEADLINE_MS,
      abandonClose: ABANDON_CLOSE_MS,
      mcpBootWait: MCP_BOOT_WAIT_MS,
      forgetWait: FORGET_WAIT_MS,
      ...deps.timeouts,
    };
    this.baseTools = [
      { ...createReadTool<ExecutionToolContext>(), replay: 'safe' },
      createWriteTool<ExecutionToolContext>(),
      createEditTool<ExecutionToolContext>(),
      createBashTool<ExecutionToolContext>(),
    ];
    deps.mcp?.onChange(() => {
      for (const tb of this.threads.values()) tb.stale = true;
    });
    deps.setup.router?.onRoute((event) => this.routed(event));
  }

  async open(row: ThreadRow): Promise<BrainSession> {
    if (!this.deps.db.up()) {
      throw new BrainUnavailable('mate-db is not up yet');
    }
    const opening = this.withKey(row.key, () => this.openLocked(row));
    const late = await this.within(opening, this.timeouts.open);
    if (late === 'late') {
      this.metrics.storeFailed('open');
      throw new BrainUnavailable(
        `opening the session took over ${this.timeouts.open / 1000}s`,
      );
    }
    return late.value;
  }

  async prompt(
    session: BrainSession,
    text: string,
    sink: PromptSink,
    _turn: TurnContext,
  ): Promise<PromptResult> {
    const tb = this.opened(session);
    if (tb.turn) return errorResult('a turn is already running here');
    return this.run(tb, sink, async (turn) => {
      const refused = await this.ready(tb);
      if (refused) return refused;
      if (turn.abandoned) throw new ClosedUnderTurn();
      const reset = session.resumed ? tb.workspaceReset : null;
      const said = text.trim() ? text : NO_TEXT;
      const input = reset ? `${resetNote(reset)}\n\n${said}` : said;
      turn.lease = tb.hands.beginTurn(this.leaseOptions(turn));
      const admitted = await this.admit(tb, input);
      if (typeof admitted !== 'string') return admitted;
      if (tb.workspaceReset) {
        tb.workspaceReset = null;
        this.write(tb.key, { workspaceReset: null });
      }
      return await this.drive(tb, turn, admitted);
    });
  }

  async resume(
    session: BrainSession,
    sink: PromptSink,
    _turn: TurnContext,
  ): Promise<PromptResult> {
    const tb = this.opened(session);
    if (tb.turn) return errorResult('a turn is already running here');
    return this.run(tb, sink, async (turn) => {
      if (this.deps.mcp) {
        await this.deps.mcp.ready(this.timeouts.mcpBootWait);
      }
      if (tb.stale) await this.reconcile(tb, true);
      const operationId =
        tb.interrupted?.operationId ??
        (await tb.lane.inspectExecution(CTX)).current?.id;
      if (!operationId) return { stopReason: 'end_turn' };
      await this.seedCalls(tb, turn);
      if (turn.abandoned) throw new ClosedUnderTurn();
      turn.lease = tb.hands.beginTurn(this.leaseOptions(turn));
      await turn.lease.warm();
      tb.interrupted = null;
      return await this.drive(tb, turn, operationId);
    });
  }

  async discard(session: BrainSession): Promise<void> {
    const tb = this.threads.get(session.key);
    if (!tb?.interrupted) return;
    try {
      if (!(await this.discardOpen(tb))) {
        this.deps.log.warn('the interrupted run would not stop in time', {
          key: tb.key,
        });
      }
    } catch (error) {
      await this.fault(tb, error);
    }
  }

  async cancel(session: BrainSession): Promise<void> {
    const tb = this.threads.get(session.key);
    const turn = tb?.turn;
    if (!tb || !turn) return;
    if (turn.operationId) this.stop(tb, turn);
    else turn.cancelRequested = true;
  }

  async release(ref: ThreadRef, reason: TeardownReason): Promise<void> {
    await this.withKey(threadKey(ref), () =>
      this.releaseLocked(ref, reason),
    ).catch((error) =>
      this.deps.log.warn('release failed', {
        key: threadKey(ref),
        error: plain(error),
      }),
    );
  }

  async forget(ref: ThreadRef): Promise<void> {
    const { store, sessions, log } = this.deps;
    const key = threadKey(ref);
    const running = this.threads.get(key)?.turn;
    if (running) {
      void this.cancel({ key, ref, resumed: false, interrupted: null });
      await this.within(running.done, this.timeouts.forgetWait);
    }
    await this.withKey(key, async () => {
      const known = this.threads.get(key)?.row;
      const row = (await store.get(key).catch(() => undefined)) ?? known;
      await this.releaseLocked(ref, 'thread-deleted');
      const ids = row ? [row.sessionId, ...row.quarantined] : [key];
      for (const id of new Set(ids)) {
        await sessions.delete(id).catch((error) =>
          log.warn('a session could not be deleted', {
            key,
            sessionId: id,
            error: plain(error),
          }),
        );
      }
    }).catch((error) =>
      log.warn('forget failed', { key, error: plain(error) }),
    );
  }

  async abandon(): Promise<void> {
    this.draining = true;
    const running = [...this.threads.values()].flatMap((tb) =>
      tb.turn ? [{ tb, turn: tb.turn }] : [],
    );
    await Promise.all(
      running.map(async ({ tb, turn }) => {
        turn.abandoned = true;
        turn.translator.stop();
        await this.within(
          tb.harness.close(CTX).catch(() => {}),
          this.timeouts.abandonClose,
        );
        await turn.lease?.abandon();
      }),
    );
  }

  /** Deletes the sessions of threads closed before `before`, and their rows. */
  async sweep(before: number): Promise<void> {
    const { store, sessions, log } = this.deps;
    let rows: ThreadRow[];
    try {
      rows = await store.closedBefore(before, SWEEP_BATCH, sweepable());
    } catch (error) {
      log.warn('the retention sweep could not list threads', {
        error: plain(error),
      });
      return;
    }
    for (const row of rows) {
      await this.withKey(row.key, async () => {
        if (this.threads.has(row.key)) return;
        const deleted = await store.deleteClosed(row.key, before);
        if (!deleted) return;
        for (const id of new Set([deleted.sessionId, ...deleted.quarantined])) {
          await sessions.delete(id);
        }
        log.info('retention deleted a thread', {
          key: row.key,
          sessions: 1 + deleted.quarantined.length,
        });
      }).catch((error) =>
        log.warn('retention could not delete a thread', {
          key: row.key,
          error: plain(error),
        }),
      );
    }
  }

  /** The thread's brain; none after SIGTERM, whose runs stay for the next process. */
  private opened(session: BrainSession): ThreadBrain {
    if (this.draining) throw new TurnAbandoned('mate is shutting down');
    const tb = this.threads.get(session.key);
    if (!tb) throw new BrainUnavailable('the thread is not open');
    return tb;
  }

  /** One turn: a throw is SIGTERM's or a fault, and the end is always logged. */
  private async run(
    tb: ThreadBrain,
    sink: PromptSink,
    body: (turn: Turn) => Promise<PromptResult>,
  ): Promise<PromptResult> {
    const turn = this.startTurn(tb, sink);
    let result: PromptResult | null = null;
    try {
      result = await body(turn);
    } catch (error) {
      result = await this.failed(tb, turn, error);
    } finally {
      await this.endTurn(tb, turn, result);
    }
    const notice = turn.translator.fellBack
      ? (this.deps.setup.router?.claimNotice() ?? null)
      : null;
    return notice ? { ...result, notice } : result;
  }

  /** A model request of a running turn went to ChatGPT or to the fallback. */
  private routed(event: RouteEvent): void {
    if (!event.sessionId) return;
    for (const tb of this.threads.values()) {
      if (`${tb.row.sessionId}:${LANE}` !== event.sessionId) continue;
      tb.turn?.translator.routed(event);
      return;
    }
  }

  private startTurn(tb: ThreadBrain, sink: PromptSink): Turn {
    let resolve = () => {};
    const done = new Promise<void>((settle) => {
      resolve = settle;
    });
    let cut = (_: CutOff) => {};
    const cutOff = new Promise<CutOff>((settle) => {
      cut = settle;
    });
    const turn: Turn = {
      translator: new TurnTranslator(sink, this.clock, this.metrics),
      leaseStop: new AbortController(),
      lease: null,
      operationId: null,
      cancelRequested: false,
      timedOut: false,
      abandoned: false,
      cutOff,
      cut,
      grace: null,
      done,
      resolve,
    };
    tb.turn = turn;
    return turn;
  }

  /**
   * Titles the calls of the newest assistant message for the resumed card; a
   * failed read leaves the bare titles.
   */
  private async seedCalls(tb: ThreadBrain, turn: Turn): Promise<void> {
    try {
      const entries = await tb.lane.findEntries(
        { type: 'message', order: 'newestFirst', limit: RESUME_LOOKBACK },
        CTX,
      );
      for (const entry of entries) {
        if (entry.type !== 'message') continue;
        const { message } = entry;
        if (!('role' in message) || message.role !== 'assistant') continue;
        for (const block of message.content) {
          if (block.type === 'toolCall') {
            turn.translator.seed(block.id, block.name, block.arguments);
          }
        }
        return;
      }
    } catch (error) {
      this.deps.log.warn('the resumed calls could not be read', {
        key: tb.key,
        error: plain(error),
      });
    }
  }

  private leaseOptions(turn: Turn) {
    return {
      onEvent: (event: Parameters<TurnTranslator['lease']>[0]) =>
        turn.translator.lease(event),
      signal: turn.leaseStop.signal,
    };
  }

  private async endTurn(
    tb: ThreadBrain,
    turn: Turn,
    result: PromptResult | null,
  ): Promise<void> {
    turn.leaseStop.abort();
    if (!turn.abandoned) {
      const summary = turn.lease ? await turn.lease.finish() : null;
      const failed = result?.stopReason === 'error';
      this.deps.log[failed ? 'warn' : 'info']('turn ended', {
        key: tb.key,
        stopReason: result?.stopReason ?? null,
        error: result?.error ?? null,
        firstTokenMs: turn.translator.firstTokenMs,
        sandbox: summary?.sandbox ?? null,
        source: summary?.source ?? null,
        stamped: summary?.stamped ?? false,
        tools: turn.translator.toolCount,
        costUsd: turn.translator.costUsd,
        route: turn.translator.route,
      });
      turn.translator.end();
    }
    if (tb.turn === turn) tb.turn = null;
    if (turn.grace) this.clock.cancel(turn.grace);
    turn.resolve();
  }

  /**
   * Before a prompt: a broken harness is opened again once its old one has
   * drained, and a lane whose tools changed is reconciled. Returns an error
   * result when the thread cannot take the prompt yet.
   */
  private async ready(tb: ThreadBrain): Promise<PromptResult | null> {
    if (tb.broken) {
      if (tb.closing && !tb.closed) return errorResult(RECOVERING);
      const setAside = tb.faults >= FAULT_LIMIT;
      await this.withKey(tb.key, () => this.openLocked(tb.row));
      if (setAside) return { ...errorResult(SET_ASIDE), reset: true };
      if (tb.interrupted && !(await this.discardOpen(tb))) {
        return errorResult(RECOVERING);
      }
    }
    if (tb.stale) await this.reconcile(tb, false);
    return null;
  }

  /** Admits the prompt; a lane still busy with a run is aborted first, once. */
  private async admit(
    tb: ThreadBrain,
    input: string,
  ): Promise<string | PromptResult> {
    for (let attempt = 0; ; attempt++) {
      const admission = await tb.lane.accept(
        { kind: 'prompt', prompt: input },
        CTX,
      );
      if (admission.ok) return admission.value.operationId;
      const error = admission.error;
      if (error._tag === 'Closed') throw new ClosedUnderTurn(error.message);
      if (error._tag !== 'LaneBusy') return errorResult(error.message);
      tb.interrupted = {
        operationId: error.operationId,
        startedAt: this.clock.now(),
      };
      if (attempt > 0 || !(await this.discardOpen(tb))) {
        return errorResult(RECOVERING);
      }
    }
  }

  private async drive(
    tb: ThreadBrain,
    turn: Turn,
    operationId: string,
  ): Promise<PromptResult> {
    turn.operationId = operationId;
    if (turn.cancelRequested) this.stop(tb, turn);
    const ms = tb.profile.turnTimeoutMs;
    const minutes = ms / 60_000;
    const timeout = this.clock.after(ms, () => {
      turn.timedOut = true;
      this.abortLane(tb);
      this.giveUp(turn, 'expired', this.timeouts.timeoutGrace);
    });
    try {
      const driven = await Promise.race([
        tb.lane.drive(
          { operationId, waitForRetry: true, pollDeferred: true },
          CTX,
        ),
        turn.cutOff,
      ]);
      if (driven === 'expired' || driven === 'stopped') {
        // SIGTERM's close is already under way, and its run stays open.
        if (turn.abandoned) throw new ClosedUnderTurn();
        this.deps.log.warn('the run would not settle; closing its harness', {
          key: tb.key,
          after: driven,
        });
        await this.closeBroken(tb);
        return driven === 'expired'
          ? errorResult(`turn ran past ${minutes} min`, turn)
          : {
              stopReason: 'cancelled',
              firstTokenMs: turn.translator.firstTokenMs,
              costUsd: turn.translator.costUsd,
            };
      }
      if (!driven.ok) {
        if (driven.error._tag === 'Closed') {
          throw new ClosedUnderTurn(driven.error.message);
        }
        throw new HarnessFault(driven.error.message, driven.error);
      }
      if (driven.value.kind !== 'settled') {
        return errorResult('the run is still waiting on the model', turn);
      }
      tb.faults = 0;
      return this.outcome(turn, driven.value.outcome, minutes);
    } finally {
      this.clock.cancel(timeout);
    }
  }

  /** Stop: the run is aborted, and closed under the turn if it will not settle. */
  private stop(tb: ThreadBrain, turn: Turn): void {
    this.abortLane(tb);
    this.giveUp(turn, 'stopped', this.timeouts.stopGrace);
  }

  /** The first timeout or Stop arms the only grace; a later one keeps it. */
  private giveUp(turn: Turn, why: CutOff, ms: number): void {
    turn.grace ??= this.clock.after(ms, () => turn.cut(why));
  }

  private outcome(
    turn: Turn,
    outcome: OperationResultRecord,
    minutes: number,
  ): PromptResult {
    const result = {
      firstTokenMs: turn.translator.firstTokenMs,
      costUsd: turn.translator.costUsd,
    };
    switch (outcome.status) {
      case 'completed':
      case 'declined':
        return { stopReason: 'end_turn', ...result };
      case 'aborted':
        return turn.timedOut
          ? {
              ...result,
              stopReason: 'error',
              error: `turn ran past ${minutes} min`,
            }
          : { stopReason: 'cancelled', ...result };
      case 'failed': {
        const message = outcome.error?.message ?? 'the run failed';
        this.metrics.providerError(providerErrorKind(message));
        return { ...result, stopReason: 'error', error: redact(message) };
      }
    }
  }

  /** A turn that threw: SIGTERM's close is `TurnAbandoned`; anything else is a fault. */
  private async failed(
    tb: ThreadBrain,
    turn: Turn,
    error: unknown,
  ): Promise<PromptResult> {
    if (error instanceof BrainUnavailable) throw error;
    const closed =
      error instanceof ClosedUnderTurn || error instanceof HarnessClosed;
    if (closed && turn.abandoned) {
      throw new TurnAbandoned('mate is shutting down');
    }
    if (
      error instanceof TypeError ||
      error instanceof RangeError ||
      !(closed || error instanceof HarnessFault || isCorrupt(error))
    ) {
      this.deps.log.error('the turn hit a bug in mate', {
        key: tb.key,
        error: plain(error),
      });
      return errorResult(`the turn failed: ${plain(error)}`, turn);
    }
    await this.fault(tb, error);
    return errorResult(
      `mate lost its session state mid-turn: ${explain(error)}`,
      turn,
    );
  }

  /** A fault: the harness is closed, and the thread recovers once it drains. */
  private async fault(tb: ThreadBrain, error: unknown): Promise<void> {
    tb.faults += 1;
    this.metrics.storeFailed('fault');
    this.deps.log.error('the harness faulted', {
      key: tb.key,
      faults: tb.faults,
      error: plain(error),
      cause: explain(error),
    });
    await this.closeBroken(tb);
  }

  /** Waits a bounded time; the thread stays `recovering` until the close drains. */
  private async closeBroken(tb: ThreadBrain): Promise<void> {
    await this.within(this.closeHarness(tb), this.timeouts.harnessClose);
  }

  /** Closes a broken harness once; its storage is done when this settles. */
  private closeHarness(tb: ThreadBrain): Promise<void> {
    tb.broken = true;
    if (!tb.closing) {
      tb.closed = false;
      const harness = tb.harness;
      tb.closing = harness
        .close(CTX)
        .catch(() => {})
        .finally(() => {
          if (tb.harness === harness) tb.closed = true;
        });
    }
    return tb.closing;
  }

  private abortLane(tb: ThreadBrain): void {
    void tb.lane.abort(CTX).catch((error) =>
      this.deps.log.warn('the run could not be aborted', {
        key: tb.key,
        error: plain(error),
      }),
    );
  }

  /**
   * Aborts the open run durably. pi's reconcile drive ignores the caller's
   * signal, so a deadline that fires is followed by a wait for idle.
   */
  private async discardOpen(tb: ThreadBrain): Promise<boolean> {
    const deadline = this.timeouts.discard;
    const abort = (ctx: Context) => tb.lane.abort(ctx);
    if ((await this.bounded(abort, deadline)) === 'late') {
      this.deps.log.info(
        'the abort ran past its deadline; waiting for the lane',
        { key: tb.key },
      );
      const idle = (ctx: Context) => tb.lane.waitForIdle(ctx);
      if ((await this.bounded(idle, deadline)) === 'late') return false;
    }
    tb.interrupted = null;
    return true;
  }

  /** Runs `work` under a context cancelled after `ms`. */
  private async bounded(
    work: (ctx: Context) => Promise<unknown>,
    ms: number,
  ): Promise<'done' | 'late'> {
    const { context, cancel } = withCancel(CTX);
    const timer = this.clock.after(ms, () => cancel(new Error('deadline')));
    try {
      await work(context);
      return 'done';
    } catch (error) {
      if (context.abortSignal?.aborted) return 'late';
      throw error;
    } finally {
      this.clock.cancel(timer);
    }
  }

  private async openLocked(row: ThreadRow): Promise<BrainSession> {
    const existing = this.threads.get(row.key);
    if (existing && !existing.broken) return this.sessionOf(existing);
    let current = existing?.row ?? row;
    if (existing) {
      // No second writer while the old harness can still commit.
      await this.closeHarness(existing);
      if (existing.faults >= FAULT_LIMIT) {
        current = await this.quarantine(current, 'faults in a row');
        existing.faults = 0;
      }
    }
    try {
      return await this.attach(current);
    } catch (first) {
      if (!isCorrupt(first)) throw this.unavailable(current, first);
      try {
        return await this.attach(current);
      } catch (second) {
        if (!isCorrupt(second)) throw this.unavailable(current, second);
        const fresh = await this.quarantine(current, explain(second));
        try {
          return await this.attach(fresh);
        } catch (third) {
          throw this.unavailable(fresh, third);
        }
      }
    }
  }

  private sessionOf(tb: ThreadBrain): BrainSession {
    return {
      key: tb.key,
      ref: tb.ref,
      resumed: tb.resumed,
      interrupted: tb.interrupted,
    };
  }

  private unavailable(row: ThreadRow, error: unknown): BrainUnavailable {
    if (error instanceof BrainUnavailable) return error;
    this.metrics.storeFailed('open');
    // Anything but an unreachable store is a bug here or in pi.
    const level = isStoreUnavailable(error) ? 'warn' : 'error';
    this.deps.log[level]('the session could not be opened', {
      key: row.key,
      sessionId: row.sessionId,
      error: plain(error),
      cause: explain(error),
    });
    return new BrainUnavailable(
      `the session could not be opened: ${explain(error)}`,
      { cause: error },
    );
  }

  /** Points the row at a fresh session; the old one stays for inspection. */
  private async quarantine(row: ThreadRow, why: string): Promise<ThreadRow> {
    const now = this.clock.now();
    this.quarantines = this.quarantines.filter(
      (at) => now - at < QUARANTINE_WINDOW_MS,
    );
    if (this.quarantines.length >= QUARANTINE_LIMIT) {
      this.deps.log.error(
        'too many sessions set aside this hour; refusing to set aside another',
        { key: row.key, sessionId: row.sessionId },
      );
      throw new BrainUnavailable('the session store looks broken');
    }
    this.quarantines.push(now);
    const sessionId = `${row.key}~${row.quarantined.length + 1}`;
    const quarantined = [...row.quarantined, row.sessionId];
    try {
      await this.deps.store.patch(row.key, { sessionId, quarantined });
    } catch (error) {
      // Nothing was set aside, so the breaker does not count it.
      const at = this.quarantines.indexOf(now);
      if (at >= 0) this.quarantines.splice(at, 1);
      throw this.unavailable(row, error);
    }
    this.metrics.storeFailed('quarantine');
    this.deps.log.error('a session was set aside', {
      key: row.key,
      from: row.sessionId,
      to: sessionId,
      why,
    });
    const fresh = { ...row, sessionId, quarantined };
    const tb = this.threads.get(row.key);
    if (tb) tb.row = fresh;
    return fresh;
  }

  /** Opens the row's session under a new harness, and reconciles its lane. */
  private async attach(row: ThreadRow): Promise<BrainSession> {
    const { setup, sessions } = this.deps;
    const profile = this.deps.profiles.get(row.profile);
    if (!profile) {
      throw new BrainUnavailable(`profile ${row.profile} is not declared`);
    }
    const session = await sessions.open(row.sessionId);
    let harness: AgentHarness<ExecutionToolContext> | null = null;
    try {
      const known = this.threads.get(row.key);
      const hands =
        known?.hands ??
        this.deps.hands.thread(row.ref, this.hooks(row.key), profile.profile);
      const created = await AgentHarness.create<ExecutionToolContext>(
        {
          session,
          models: setup.models,
          model: profile.model,
          thinkingLevel: profile.thinking,
          tools: this.listedTools(profile.profile),
          toolContext: { env: hands.env },
          systemPrompt: profile.prompts[row.ref.surface],
          streamOptions: { timeoutMs: PROVIDER_TIMEOUT_MS },
          ...(this.deps.retry ? { retry: this.deps.retry } : {}),
        },
        CTX,
      );
      harness = created.harness;
      const lane = await harness.lane(LANE, CTX);
      const open = created.open.find((operation) => operation.lane === LANE);
      const stats = await session.getStats(CTX);
      await this.reconcileLane(harness, lane, Boolean(open), profile);
      const fresh = {
        row,
        profile,
        harness,
        lane,
        interrupted: open
          ? { operationId: open.operationId, startedAt: open.startedAt }
          : null,
        resumed: stats.messageCount > 0,
        broken: false,
        closing: null,
        closed: false,
        stale: false,
      };
      known?.unsubscribe();
      const tb: ThreadBrain = known
        ? Object.assign(known, fresh)
        : {
            key: row.key,
            ref: row.ref,
            hands,
            workspaceReset: row.workspaceReset,
            faults: 0,
            turn: null,
            unsubscribe: () => {},
            ...fresh,
          };
      tb.unsubscribe = this.subscribe(row.key, harness);
      this.threads.set(row.key, tb);
      return this.sessionOf(tb);
    } catch (error) {
      if (harness) await harness.close(CTX).catch(() => {});
      else await session.close(CTX).catch(() => {});
      throw error;
    }
  }

  /**
   * The base and bridged tools `profile` lists, each name once. The only list
   * the harness is given, so a tool the profile does not list never runs.
   */
  private listedTools(profile: Profile): BridgedTool[] {
    const byName = new Map<string, BridgedTool>();
    for (const tool of [...this.baseTools, ...(this.deps.mcp?.tools() ?? [])]) {
      if (lists(profile, tool.name) && !byName.has(tool.name)) {
        byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
  }

  private reconcile(tb: ThreadBrain, open: boolean): Promise<void> {
    tb.stale = false;
    return this.reconcileLane(tb.harness, tb.lane, open, tb.profile);
  }

  /**
   * Brings a lane saved by an older mate to its profile's model, thinking
   * level and tools. While a run is open the tools are only added to: pi
   * resumes a step with the names it captured, so each must still resolve.
   */
  private async reconcileLane(
    harness: AgentHarness<ExecutionToolContext>,
    lane: AgentLane,
    open: boolean,
    profile: BrainProfile,
  ): Promise<void> {
    const { model, thinking } = profile;
    const saved = await lane.getActiveTools(CTX);
    const listed = this.listedTools(profile.profile);
    const names = listed.map((tool) => tool.name);
    const standIns = saved
      .filter((name) => !names.includes(name))
      .map(unreachableTool);
    await harness.setTools([...listed, ...standIns], CTX);
    const { configuredModel } = await lane.inspectExecution(CTX);
    if (
      configuredModel.provider !== model.provider ||
      configuredModel.modelId !== model.id
    ) {
      await lane.setModel({ provider: model.provider, modelId: model.id }, CTX);
    }
    if ((await lane.getThinkingLevel(CTX)) !== thinking) {
      await lane.setThinkingLevel(thinking, CTX);
    }
    const desired = open ? [...new Set([...saved, ...names])] : names;
    if (!sameNames(saved, desired)) await lane.setActiveTools(desired, CTX);
  }

  /** One sync listener per event type, routed to the running turn. */
  private subscribe(
    key: string,
    harness: AgentHarness<ExecutionToolContext>,
  ): () => void {
    const current = () => {
      const tb = this.threads.get(key);
      return tb?.harness === harness ? tb : undefined;
    };
    const route = (event: HarnessEvent) => {
      const turn = current()?.turn;
      if (!turn?.operationId) return;
      try {
        turn.translator.event(event);
      } catch (error) {
        this.deps.log.warn('an event could not be drawn', {
          key,
          type: event.type,
          error: plain(error),
        });
      }
    };
    const offs = ROUTED.map((type) => harness.events.on(type, route));
    offs.push(
      harness.events.on('fault', (event) => {
        const tb = current();
        if (tb) tb.broken = true;
        this.deps.log.error('the harness reported a fault', {
          key,
          code: event.code,
          message: event.message,
        });
      }),
      harness.events.on('handler_error', (event) =>
        this.deps.log.warn('a harness handler failed', {
          key,
          error: event.error,
        }),
      ),
    );
    return () => {
      for (const off of offs) off();
    };
  }

  private hooks(key: string): ThreadHandsHooks {
    return {
      onSandbox: (name) => {
        const tb = this.threads.get(key);
        if (tb) tb.workspaceReset = null;
        this.write(key, { sandbox: name, workspaceReset: null });
      },
      onSandboxGone: (reason) => {
        const tb = this.threads.get(key);
        if (tb) tb.workspaceReset = reason;
        this.write(key, { sandbox: null, workspaceReset: reason });
      },
    };
  }

  /** Sync for the hooks: the write runs behind, and `release` waits for it. */
  private write(key: string, patch: ThreadRowPatch): void {
    const pending = this.writes.get(key) ?? new Set<Promise<void>>();
    this.writes.set(key, pending);
    const write: Promise<void> = this.deps.store
      .patch(key, patch)
      .catch((error) => {
        this.metrics.storeFailed('rows');
        this.deps.log.warn('a thread row could not be written', {
          key,
          error: plain(error),
        });
      })
      .finally(() => pending.delete(write));
    pending.add(write);
  }

  private async releaseLocked(
    ref: ThreadRef,
    reason: TeardownReason,
  ): Promise<void> {
    const key = threadKey(ref);
    const tb = this.threads.get(key);
    if (tb) {
      this.threads.delete(key);
      tb.unsubscribe();
      await this.within(
        tb.harness.close(CTX).catch(() => {}),
        this.timeouts.harnessClose,
      );
    }
    await this.deps.hands.release(ref, reason);
    await Promise.allSettled([...(this.writes.get(key) ?? [])]);
  }

  private withKey<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.keyLocks.set(key, settled);
    void settled.then(() => {
      if (this.keyLocks.get(key) === settled) this.keyLocks.delete(key);
    });
    return run;
  }

  /** `work`'s value, or `late` once `ms` passes on the clock. */
  private async within<T>(
    work: Promise<T>,
    ms: number,
  ): Promise<{ value: T } | 'late'> {
    let timer: Handle | null = null;
    const late = new Promise<'late'>((resolve) => {
      timer = this.clock.after(ms, () => resolve('late'));
    });
    try {
      return await Promise.race([work.then((value) => ({ value })), late]);
    } finally {
      if (timer) this.clock.cancel(timer);
    }
  }
}
