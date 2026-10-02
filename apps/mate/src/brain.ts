/**
 * The brain: one pi-durable harness per open thread, over the thread's own
 * session in mate-db, in mate's own process, with the prompt, model, tools
 * and turn timeout of the row's profile. The model streams before any sandbox
 * exists; the hands lease one on the first tool call. A run a restart cut off
 * stays pending in mate-db and resumes, and a harness that faults is closed,
 * drained and opened again.
 */

import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withCancel } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  ConversationBusy,
  type ConversationRetryPolicy,
  createRegistry,
  DEFAULT_RETRY_POLICY,
  defineExtension,
  type Extension,
  Harness,
  type Registry,
  type SettledSubmissionRecord,
  type SnapshotEvent,
  type Storage,
  type SubmissionId,
  section,
  watchEvents,
} from '@earendil-works/pi-durable';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools';
import { deleteStorage, openStorage } from '@repo/pi-store-postgres';
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
/** The one extension of a thread's registry: its profile's prompt and tools. */
const EXTENSION = 'mate';
const CTX = BACKGROUND_CONTEXT;

export const RECOVERING =
  "mate is still recovering this thread's memory — try again in a minute";
export const SET_ASIDE =
  "mate set this thread's memory aside after repeated faults and starts it afresh — send that again";
/** pi refuses an empty prompt, and a bare mention or an attachment has no text. */
export const NO_TEXT =
  '[mate: this message has no text. mate passes on only the text of a message, not its attachments.]';

export interface SessionSource {
  open(id: string): Promise<Storage>;
  delete(id: string): Promise<void>;
}

export function postgresSessions(sql: SQL): SessionSource {
  return {
    open: (id) => openStorage(sql, id),
    delete: (id) => deleteStorage(sql, id),
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
  /** pi's retries of a model request; tests shorten the backoff. */
  retry?: Partial<ConversationRetryPolicy>;
  timeouts?: Partial<BrainTimeouts>;
}

interface Turn {
  readonly translator: TurnTranslator;
  /** Aborted when the turn ends: it bounds a wait for a sandbox slot. */
  readonly leaseStop: AbortController;
  lease: TurnLease | null;
  /** Set once the run is admitted. */
  submission: SubmissionId | null;
  /** pi's events route here from just before the prompt is submitted. */
  live: boolean;
  cancelRequested: boolean;
  timedOut: boolean;
  /** SIGTERM closed the harness under this turn. */
  abandoned: boolean;
  /** Resolves when a timeout or a Stop gives up waiting for the run to settle. */
  readonly cutOff: Promise<CutOff>;
  cut(why: CutOff): void;
  /** Rejects when the session under the run is poisoned: the run will never settle. */
  readonly poisoned: Promise<never>;
  poison(error: unknown): void;
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
  harness: Harness;
  root: Conversation;
  registry: Registry;
  events: AgentEventStream;
  /** The run the store held open at attach, and the calls it had made. */
  open: OpenRun | null;
  interrupted: InterruptedRun | null;
  resumed: boolean;
  workspaceReset: SandboxGoneReason | null;
  faults: number;
  /** The harness faulted or timed out; the next prompt opens it again. */
  broken: boolean;
  /** The broken harness's close, which drains the commits it admitted. */
  closing: Promise<void> | null;
  closed: boolean;
  turn: Turn | null;
}

interface OpenRun {
  readonly submission: SubmissionId;
  readonly calls: readonly { id: string; name: string; args: unknown }[];
}

/** A pi call that threw: the session's storage failed, or its data breaks pi's rules. */
class HarnessFault extends Error {
  override readonly name = 'HarnessFault';
  constructor(cause: unknown) {
    super('the pi session failed', { cause });
  }
}

/** pi rejects every call on a closed harness with one of these messages. */
function isClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'Harness is closed' ||
      error.message === 'Session is closed')
  );
}

/**
 * `models` with the session id on every request: pi-durable sends none, and
 * the router names a request's thread by it. Methods stay bound to `models`.
 */
function withSession(models: Models, sessionId: string): Models {
  const tagged = {
    streamSimple: ((model, context, options) =>
      models.streamSimple(model, context, {
        ...options,
        sessionId,
      })) satisfies Models['streamSimple'],
    completeSimple: ((model, context, options) =>
      models.completeSimple(model, context, {
        ...options,
        sessionId,
      })) satisfies Models['completeSimple'],
  };
  return new Proxy(models, {
    get(target, key) {
      if (key in tagged) return tagged[key as keyof typeof tagged];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The run a snapshot shows open, with the calls of its newest assistant message. */
function openRun(snapshot: SnapshotEvent): OpenRun | null {
  const submission = snapshot.run?.inputs[0];
  if (submission === undefined) return null;
  for (const entry of [...snapshot.entries].reverse()) {
    const message = entry.model?.[0];
    if (message?.role !== 'assistant') continue;
    return {
      submission,
      calls: message.content.flatMap((block) =>
        block.type === 'toolCall'
          ? [{ id: block.id, name: block.name, args: block.arguments }]
          : [],
      ),
    };
  }
  return { submission, calls: [] };
}

/** When the newest user message was placed, as far as the transcript says. */
function lastAsked(snapshot: SnapshotEvent): number | null {
  for (const entry of [...snapshot.entries].reverse()) {
    const message = entry.model?.[0];
    if (message?.role === 'user') return message.timestamp;
  }
  return null;
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

/** What broke: a `HarnessFault` keeps the real error as its cause. */
function explain(error: unknown): string {
  const cause =
    error instanceof HarnessFault && error.cause !== undefined
      ? error.cause
      : error;
  return redact(storeError(cause));
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
      { ...createReadTool(), replay: 'safe' },
      createWriteTool(),
      createEditTool(),
      createBashTool(),
    ];
    // Replaces the extension in place: a request under way keeps its tools.
    deps.mcp?.onChange(() => {
      for (const tb of this.threads.values()) {
        tb.registry.install(this.extension(tb.profile, tb.ref));
      }
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
      const admitted = await this.admit(tb, turn, input);
      if (typeof admitted !== 'number') return admitted;
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
      const open = tb.interrupted ? tb.open : null;
      if (!open) return { stopReason: 'end_turn' };
      for (const call of open.calls) {
        turn.translator.seed(call.id, call.name, call.args);
      }
      if (turn.abandoned) throw new ClosedUnderTurn();
      turn.lease = tb.hands.beginTurn(this.leaseOptions(turn));
      await turn.lease.warm();
      tb.interrupted = null;
      turn.live = true;
      return await this.drive(tb, turn, open.submission);
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
    if (turn.submission !== null) this.stop(tb, turn);
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
      if (tb.row.sessionId !== event.sessionId) continue;
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
    let poison = (_: unknown) => {};
    const poisoned = new Promise<never>((_, reject) => {
      poison = reject;
    });
    // Nothing races it until the run is driven.
    poisoned.catch(() => {});
    const turn: Turn = {
      translator: new TurnTranslator(
        sink,
        this.clock,
        this.metrics,
        this.deps.retry?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
      ),
      leaseStop: new AbortController(),
      lease: null,
      submission: null,
      live: false,
      poisoned,
      poison,
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
   * drained. Returns an error result when the thread cannot take the prompt
   * yet.
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
    return null;
  }

  /** Admits the prompt; a conversation still busy with a run is aborted first, once. */
  private async admit(
    tb: ThreadBrain,
    turn: Turn,
    input: string,
  ): Promise<SubmissionId | PromptResult> {
    for (let attempt = 0; ; attempt++) {
      turn.live = true;
      try {
        const submission = await this.pi(() =>
          tb.root.submit(
            { type: 'input', content: input, whenBusy: 'reject' },
            CTX,
          ),
        );
        return submission.id;
      } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error;
      }
      // The discarded run's last events are not this turn's to draw.
      turn.live = false;
      tb.interrupted = {
        operationId: String(tb.open?.submission ?? ''),
        startedAt: this.clock.now(),
      };
      if (attempt > 0 || !(await this.discardOpen(tb))) {
        return errorResult(RECOVERING);
      }
    }
  }

  /** Runs a pi call: a closed harness is the turn's close, any other failure a fault. */
  private async pi<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ConversationBusy) throw error;
      if (isClosed(error)) throw new ClosedUnderTurn(plain(error));
      throw new HarnessFault(error);
    }
  }

  private async drive(
    tb: ThreadBrain,
    turn: Turn,
    id: SubmissionId,
  ): Promise<PromptResult> {
    turn.submission = id;
    if (turn.cancelRequested) this.stop(tb, turn);
    const ms = tb.profile.turnTimeoutMs;
    const minutes = ms / 60_000;
    const timeout = this.clock.after(ms, () => {
      turn.timedOut = true;
      this.abortRun(tb);
      this.giveUp(turn, 'expired', this.timeouts.timeoutGrace);
    });
    try {
      const settling = this.pi(async () => {
        const submission = await tb.harness.submission(id, CTX);
        if (!submission) throw new Error(`pi lost submission ${id}`);
        return submission.wait(CTX);
      });
      // A cut-off turn leaves the wait behind; the close rejects it.
      settling.catch(() => {});
      const settled = await Promise.race([
        settling,
        turn.cutOff,
        turn.poisoned,
      ]);
      if (settled === 'expired' || settled === 'stopped') {
        // SIGTERM's close is already under way, and its run stays open.
        if (turn.abandoned) throw new ClosedUnderTurn();
        this.deps.log.warn('the run would not settle; closing its harness', {
          key: tb.key,
          after: settled,
        });
        await this.closeBroken(tb);
        return settled === 'expired'
          ? errorResult(`turn ran past ${minutes} min`, turn)
          : {
              stopReason: 'cancelled',
              firstTokenMs: turn.translator.firstTokenMs,
              costUsd: turn.translator.costUsd,
            };
      }
      tb.faults = 0;
      return this.outcome(turn, settled, minutes);
    } finally {
      this.clock.cancel(timeout);
    }
  }

  /** Stop: the run is aborted, and closed under the turn if it will not settle. */
  private stop(tb: ThreadBrain, turn: Turn): void {
    this.abortRun(tb);
    this.giveUp(turn, 'stopped', this.timeouts.stopGrace);
  }

  /** The first timeout or Stop arms the only grace; a later one keeps it. */
  private giveUp(turn: Turn, why: CutOff, ms: number): void {
    turn.grace ??= this.clock.after(ms, () => turn.cut(why));
  }

  private outcome(
    turn: Turn,
    settled: SettledSubmissionRecord,
    minutes: number,
  ): PromptResult {
    const result = {
      firstTokenMs: turn.translator.firstTokenMs,
      costUsd: turn.translator.costUsd,
    };
    if (settled.status === 'done') return { stopReason: 'end_turn', ...result };
    const detail =
      typeof settled.detail === 'string' && settled.detail
        ? settled.detail
        : null;
    switch (settled.reason) {
      case 'aborted':
        return turn.timedOut
          ? {
              ...result,
              stopReason: 'error',
              error: `turn ran past ${minutes} min`,
            }
          : { stopReason: 'cancelled', ...result };
      case 'model_error': {
        const message = detail ?? 'the run failed';
        this.metrics.providerError(providerErrorKind(message));
        return { ...result, stopReason: 'error', error: redact(message) };
      }
      default:
        return {
          ...result,
          stopReason: 'error',
          error: redact(
            `the run ended unanswered (${settled.reason})${detail ? `: ${detail}` : ''}`,
          ),
        };
    }
  }

  /** A turn that threw: SIGTERM's close is `TurnAbandoned`; anything else is a fault. */
  private async failed(
    tb: ThreadBrain,
    turn: Turn,
    error: unknown,
  ): Promise<PromptResult> {
    if (error instanceof BrainUnavailable) throw error;
    const closed = error instanceof ClosedUnderTurn;
    if (closed && turn.abandoned) {
      throw new TurnAbandoned('mate is shutting down');
    }
    if (!(closed || error instanceof HarnessFault)) {
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

  private abortRun(tb: ThreadBrain): void {
    void tb.root.abort(CTX).catch((error) =>
      this.deps.log.warn('the run could not be aborted', {
        key: tb.key,
        error: plain(error),
      }),
    );
  }

  /**
   * Aborts the open run durably. A deadline that fires cancels only the wait,
   * not the abort, so it is followed by a wait for idle.
   */
  private async discardOpen(tb: ThreadBrain): Promise<boolean> {
    const deadline = this.timeouts.discard;
    const abort = (ctx: Context) => this.pi(() => tb.root.abort(ctx));
    if ((await this.bounded(abort, deadline)) === 'late') {
      this.deps.log.info(
        'the abort ran past its deadline; waiting for the run',
        { key: tb.key },
      );
      const idle = (ctx: Context) => this.pi(() => tb.root.waitForIdle(ctx));
      if ((await this.bounded(idle, deadline)) === 'late') return false;
    }
    tb.interrupted = null;
    tb.open = null;
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
    // pi has no error that says a stored session is corrupt: one it cannot
    // open after a rollback fails the same way. So a session that will not
    // open stays where it is, and only faults mid-turn set one aside.
    try {
      return await this.attach(current);
    } catch (error) {
      throw this.unavailable(current, error);
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

  /** Opens the row's session under a new harness, on its profile's model. */
  private async attach(row: ThreadRow): Promise<BrainSession> {
    const { setup, sessions } = this.deps;
    const profile = this.deps.profiles.get(row.profile);
    if (!profile) {
      throw new BrainUnavailable(`profile ${row.profile} is not declared`);
    }
    const known = this.threads.get(row.key);
    const hands =
      known?.hands ??
      this.deps.hands.thread(row.ref, this.hooks(row.key), profile.profile);
    const registry = createRegistry();
    registry.install(this.extension(profile, row.ref));
    const storage = await sessions.open(row.sessionId);
    let harness: Harness | null = null;
    try {
      // A failed open closes its own harness, and the storage under it.
      const opened: Harness = await Harness.open(
        storage,
        {
          models: withSession(setup.models, row.sessionId),
          registry,
          settings: {
            stream: { timeoutMs: PROVIDER_TIMEOUT_MS },
            ...(this.deps.retry ? { retry: this.deps.retry } : {}),
          },
          env: () => hands.env,
          now: () => this.clock.now(),
          onReport: (error) => {
            if (harness) this.reported(row.key, harness, error);
          },
        },
        CTX,
      );
      harness = opened;
      const model = {
        provider: profile.model.provider,
        modelId: profile.model.id,
      };
      const root = await opened.root(CTX, {
        agent: { model, thinkingLevel: profile.thinking },
      });
      const events = await watchEvents(opened, root.id, CTX);
      const { agent } = events.snapshot;
      if (
        agent.model?.provider !== model.provider ||
        agent.model.modelId !== model.modelId ||
        agent.thinkingLevel !== profile.thinking
      ) {
        await root.configure({ model, thinkingLevel: profile.thinking }, CTX);
      }
      const open = openRun(events.snapshot);
      const fresh = {
        row,
        profile,
        harness: opened,
        root,
        registry,
        events,
        open,
        interrupted: open
          ? {
              operationId: String(open.submission),
              startedAt: lastAsked(events.snapshot) ?? this.clock.now(),
            }
          : null,
        resumed: events.snapshot.entries.length > 0,
        broken: false,
        closing: null,
        closed: false,
      };
      const tb: ThreadBrain = known
        ? Object.assign(known, fresh)
        : {
            key: row.key,
            ref: row.ref,
            hands,
            workspaceReset: row.workspaceReset,
            faults: 0,
            turn: null,
            ...fresh,
          };
      this.subscribe(row.key, opened, events);
      this.threads.set(row.key, tb);
      // A listing that changed while this opened reached no registry.
      registry.install(this.extension(profile, row.ref));
      return this.sessionOf(tb);
    } catch (error) {
      if (harness) await harness.close(CTX).catch(() => {});
      throw new HarnessFault(error);
    }
  }

  /** The profile's prompt for the thread's surface, and the tools it lists. */
  private extension(profile: BrainProfile, ref: ThreadRef): Extension {
    return defineExtension({
      name: EXTENSION,
      tools: this.listedTools(profile.profile),
      sections: [
        section('mate', () => profile.prompts[ref.surface], { tag: false }),
      ],
    });
  }

  /**
   * The base and bridged tools `profile` lists, each name once. The only
   * tools the thread's registry holds, so one the profile does not list never
   * runs.
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

  /** Routes the harness's event batches to the running turn. */
  private subscribe(
    key: string,
    harness: Harness,
    events: AgentEventStream,
  ): void {
    const route = (event: AgentEvent) => {
      const tb = this.threads.get(key);
      const turn = tb?.harness === harness ? tb.turn : null;
      if (!turn?.live) return;
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
    events.start(async (batch) => {
      for (const event of batch) route(event);
    });
  }

  /**
   * pi reports what it cannot throw to a caller. Two reports leave the run
   * never settling, so the running turn faults. A commit the store refused
   * because mate-db is down is retried for as long as it stays down. A
   * storage failure of unknown outcome poisons the session, which an empty
   * commit tells.
   */
  private reported(key: string, harness: Harness, error: unknown): void {
    this.deps.log.warn('pi reported a failure', {
      key,
      error: plain(error),
      cause: redact(storeError(error)),
    });
    const current = () => {
      const tb = this.threads.get(key);
      return tb?.harness === harness ? tb : null;
    };
    const tb = current();
    if (tb && isStoreUnavailable(error)) {
      tb.broken = true;
      tb.turn?.poison(new HarnessFault(error));
      return;
    }
    void harness
      .commit(() => undefined, CTX)
      .catch((poison) => {
        const tb = current();
        if (!tb || isClosed(poison)) return;
        tb.broken = true;
        // The poison error only says to reopen; its cause says why.
        const why = poison instanceof Error ? poison.cause : undefined;
        tb.turn?.poison(new HarnessFault(why ?? poison));
      });
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
