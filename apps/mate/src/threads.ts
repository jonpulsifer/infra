/**
 * The thread state machine. Each thread owns at most one sandbox. The
 * concurrency cap, the queue and the daily turn budget span every surface.
 */
import type { Clock, Handle } from './clock.ts';
import type { Config } from './config.ts';
import { type Log, plain } from './log.ts';
import {
  type Instruments,
  lazyInstruments,
  type TeardownReason,
} from './metrics.ts';
import {
  ATTACH_FAILED,
  ATTACHING,
  DAY_SPENT,
  HARNESS_FAILED,
  MINT_FAILED,
  MINT_STEPS,
  NEVER_STARTED,
  RESTARTED,
  SANDBOX_CLOSED,
  SANDBOX_DIED,
  STOPPED_WAITING,
  THREAD_SPENT,
  UNDELIVERED,
  WAITING,
} from './notices.ts';
import { Progress } from './progress.ts';
import { EDIT_CADENCE_MS, Reply, RUN_GRACE_MS } from './reply.ts';
import type {
  MintedRef,
  PromptResult,
  Sandboxes,
  SandboxRef,
  Session,
} from './sandbox.ts';
import {
  type Inbound,
  type Mark,
  type MessageRef,
  type Outcome,
  type Surface,
  type SurfaceName,
  type ThreadRef,
  threadKey,
} from './surface.ts';
import { replayPreamble } from './transcript.ts';

export type { Inbound };

export type ThreadState =
  | 'new'
  | 'waiting'
  | 'minting'
  | 'attached'
  | 'turn'
  | 'tearing-down'
  | 'closed'
  | 'rehydrating';

interface Prompt {
  text: string;
  raw: string;
  authorId: string;
  message: MessageRef;
}

interface Thread {
  /** Unique across every surface. */
  key: string;
  ref: ThreadRef;
  surface: Surface;
  state: ThreadState;
  sandbox: SandboxRef | null;
  session: Session | null;
  pending: Prompt[];
  turns: number;
  quiet: Handle | null;
  /** The status line shown while the thread waits for a sandbox. */
  progress: Progress | null;
  /** Set when the session did not resume; the next prompt carries the transcript. */
  replay: boolean;
  /** Catches a Stop that arrives before the prompt reaches the harness. */
  stopRequested: boolean;
  /**
   * Serializes marks: a turn refused on arrival marks its message twice in
   * one tick, and applied out of order the stale mark would stay.
   */
  marks: Promise<void>;
}

export const THREAD_NAME_MAX = 100;
const DAY_MS = 86_400_000;
const HOLDING_A_SLOT: ReadonlySet<ThreadState> = new Set([
  'minting',
  'attached',
  'turn',
  'tearing-down',
  'rehydrating',
]);

export type ThreadsConfig = Pick<
  Config,
  'quietMs' | 'maxTurnsPerThread' | 'maxTurnsPerDay' | 'maxConcurrent'
>;

export interface ThreadsDeps {
  surfaces: readonly Surface[];
  sandboxes: Sandboxes;
  clock: Clock;
  log: Log;
  config: ThreadsConfig;
  editCadenceMs?: number;
  /** How long a run of text is a step before it becomes the answer. */
  runGraceMs?: number;
  progressCadenceMs?: number;
  metrics?: Instruments;
}

export function stripMention(content: string, me: string): string {
  return content
    .replace(new RegExp(`<@!?${me}>`, 'g'), '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function threadName(content: string, me: string): string {
  const first = stripMention(content, me).split('\n')[0]?.trim() ?? '';
  if (!first) return 'mate';
  return first.length > THREAD_NAME_MAX
    ? `${first.slice(0, THREAD_NAME_MAX - 1)}…`
    : first;
}

export class Threads {
  private readonly threads = new Map<string, Thread>();
  private readonly surfaces = new Map<SurfaceName, Surface>();
  private readonly waiting: string[] = [];
  private readonly dayTurns: number[] = [];
  private readonly backlog: Inbound[] = [];
  private readonly metrics: Instruments;
  private hydrating = false;

  constructor(private readonly deps: ThreadsDeps) {
    this.metrics = deps.metrics ?? lazyInstruments();
    for (const surface of deps.surfaces) {
      this.surfaces.set(surface.name, surface);
    }
  }

  stateOf(key: string): ThreadState | undefined {
    return this.threads.get(key)?.state;
  }

  get waitingIds(): readonly string[] {
    return this.waiting;
  }

  get surfaceNames(): SurfaceName[] {
    return [...this.surfaces.keys()];
  }

  /** Registers a thread from before a restart, so a reply in it needs no mention. */
  adopt(ref: ThreadRef): void {
    const surface = this.surfaces.get(ref.surface);
    if (surface) this.ensure(surface, ref);
  }

  /** Surfaces connect independently, so each rehydrates only its own sandboxes. */
  async add(surface: Surface): Promise<void> {
    this.surfaces.set(surface.name, surface);
    await this.rehydrate(surface.name);
  }

  /**
   * Re-attaches to existing sandboxes, `only` one surface's when given. Messages
   * that arrive meanwhile wait until it ends, so no thread is minted twice.
   */
  async rehydrate(only?: SurfaceName): Promise<void> {
    const { sandboxes, log } = this.deps;
    this.hydrating = true;
    try {
      for (const sandbox of await sandboxes.list()) {
        if (only && sandbox.thread.surface !== only) continue;
        const surface = this.surfaces.get(sandbox.thread.surface);
        if (!surface) {
          log.warn('rehydrate found a sandbox on a surface mate is not on', {
            sandbox: sandbox.name,
            surface: sandbox.thread.surface,
          });
          continue;
        }
        const thread = this.ensure(surface, sandbox.thread);
        if (thread.state !== 'new') {
          log.warn('rehydrate skipped a thread already in motion', {
            threadId: thread.ref.id,
            state: thread.state,
          });
          continue;
        }
        thread.sandbox = sandbox;
        this.to(thread, 'rehydrating');
        // A turn was running when the process died: explain the missing answer
        // and clear a thread-level working sign that outlived it.
        if (sandbox.turnInFlight) {
          await this.tell(thread, RESTARTED);
          await thread.surface.settle?.(thread.ref).catch((error) =>
            log.warn('settle failed', {
              threadId: thread.ref.id,
              error: plain(error),
            }),
          );
        }
        try {
          const session = await sandboxes.attach(sandbox);
          thread.session = session;
          thread.replay = !session.resumed;
          this.to(thread, 'attached');
          await this.pump(thread);
        } catch (error) {
          log.warn('rehydrate failed; tearing down', {
            threadId: thread.ref.id,
            error: plain(error),
          });
          await this.close(thread, {
            line: SANDBOX_CLOSED,
            archive: false,
            reason: 'restart',
          });
        }
      }
    } finally {
      this.hydrating = false;
      for (const message of this.backlog.splice(0)) {
        await this.onMessage(message);
      }
    }
  }

  async onMessage(message: Inbound): Promise<void> {
    const { log } = this.deps;
    const surface = this.surfaces.get(message.surface);
    if (!surface || message.authorIsBot) return;
    // Read back as a human's, mate's own post would answer itself. Not every
    // Slack message shape flags a bot.
    if (message.authorId === surface.me) return;
    // A reply in a thread mate owns needs no mention, so this is its only gate.
    if (!surface.allowedUserIds.has(message.authorId)) return;
    if (this.hydrating) {
      this.backlog.push(message);
      return;
    }
    const prompt = {
      text: stripMention(message.content, surface.me),
      raw: message.content,
      authorId: message.authorId,
      message: { channelId: message.channelId, id: message.id },
    };
    const known = message.threadId
      ? this.threads.get(
          threadKey({
            surface: surface.name,
            channelId: message.channelId,
            id: message.threadId,
          }),
        )
      : undefined;
    if (known) {
      this.accept(known, prompt);
      return;
    }
    if (
      !surface.allowedChannelIds.has(message.channelId) ||
      !message.mentionsMe
    ) {
      return;
    }
    let ref: ThreadRef;
    try {
      ref = await surface.openThread(
        message,
        threadName(message.content, surface.me),
      );
    } catch (error) {
      log.warn('thread create failed', {
        surface: surface.name,
        channelId: message.channelId,
        messageId: message.id,
        error: plain(error),
      });
      return;
    }
    this.accept(this.ensure(surface, ref), prompt);
  }

  async onStop(
    key: string,
    userId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    const { sandboxes, log } = this.deps;
    await ack().catch((error) =>
      log.warn('stop ack failed', { threadId: key, error: plain(error) }),
    );
    const thread = this.threads.get(key);
    if (!thread?.surface.allowedUserIds.has(userId)) return;
    if (thread.state !== 'turn') return;
    // A turn still building its prompt has nothing in the harness to cancel.
    thread.stopRequested = true;
    if (thread.session) await sandboxes.cancel(thread.session);
  }

  async onThreadArchived(ref: ThreadRef): Promise<void> {
    const thread = this.threads.get(threadKey(ref));
    if (!thread) return;
    if (thread.state === 'attached') {
      await this.close(thread, {
        line: SANDBOX_CLOSED,
        archive: true,
        reason: 'archived',
      });
    } else if (thread.state === 'waiting') {
      this.leaveQueue(thread);
      // The thread is archived, so nobody would read a closing sentence.
      await this.endProgress(thread, null);
    }
  }

  async onThreadDeleted(ref: ThreadRef): Promise<void> {
    const key = threadKey(ref);
    const thread = this.threads.get(key);
    if (!thread) return;
    this.threads.delete(key);
    this.disarmQuiet(thread);
    // The line's redraw timer outlives the thread, so end it here.
    await this.endProgress(thread, null);
    const at = this.waiting.indexOf(key);
    if (at >= 0) this.waiting.splice(at, 1);
    if (thread.sandbox) {
      await this.deps.sandboxes.teardown(thread.sandbox).catch(() => {});
      this.metrics.teardown('thread-deleted');
    }
    this.deps.log.info('thread deleted', {
      surface: ref.surface,
      threadId: ref.id,
      sandbox: thread.sandbox?.name ?? null,
      turns: thread.turns,
    });
    this.report();
    this.pumpWaiting();
  }

  /**
   * Ends every status line at shutdown, so none still claims a sandbox is
   * starting. A kill skips this, which is why no line promises an answer.
   */
  async quiesce(): Promise<void> {
    for (const thread of this.threads.values()) {
      if (thread.progress) await this.endProgress(thread, NEVER_STARTED);
    }
  }

  private ensure(surface: Surface, ref: ThreadRef): Thread {
    const key = threadKey(ref);
    let thread = this.threads.get(key);
    if (!thread) {
      thread = {
        key,
        ref,
        surface,
        state: 'new',
        sandbox: null,
        session: null,
        pending: [],
        turns: 0,
        quiet: null,
        progress: null,
        replay: false,
        stopRequested: false,
        marks: Promise.resolve(),
      };
      this.threads.set(key, thread);
    }
    return thread;
  }

  /** The only place a thread changes state, so every change is logged. */
  private to(thread: Thread, state: ThreadState): void {
    thread.state = state;
    this.deps.log.info('thread state', {
      surface: thread.ref.surface,
      threadId: thread.ref.id,
      state,
      sandbox: thread.sandbox?.name ?? null,
      turns: thread.turns,
    });
    this.report();
  }

  private report(): void {
    let live = 0;
    for (const thread of this.threads.values()) {
      if (thread.sandbox) live += 1;
    }
    this.metrics.sandboxesLive(live);
    this.metrics.queueDepth(this.waiting.length);
  }

  private accept(thread: Thread, prompt: Prompt): void {
    thread.pending.push(prompt);
    this.mark(thread, [prompt], 'seen');
    this.disarmQuiet(thread);
    void this.pump(thread);
  }

  private async pump(thread: Thread): Promise<void> {
    try {
      switch (thread.state) {
        case 'new':
        case 'closed':
          if (thread.pending.length === 0) return;
          // Before mint or enqueue: the status line is the first thing the human sees.
          this.acknowledge(thread);
          if (this.freeSlots() > 0) await this.mint(thread);
          else this.enqueue(thread);
          return;
        case 'attached':
          if (thread.pending.length > 0) await this.runTurn(thread);
          else this.armQuiet(thread);
          return;
        case 'waiting':
          this.armQuiet(thread);
          return;
        default:
          return;
      }
    } catch (error) {
      this.deps.log.error('thread pump failed', {
        threadId: thread.ref.id,
        state: thread.state,
        error: plain(error),
      });
    }
  }

  /**
   * Raises the status line once. The thread holds the only reference to a line
   * and only `end` stops its redraw, so a second line would orphan the first.
   */
  private acknowledge(thread: Thread): void {
    if (thread.progress) return;
    thread.progress = new Progress(
      thread.surface.notice(thread.ref),
      this.deps.clock,
      this.deps.log,
      thread.ref.id,
      MINT_STEPS.creating,
      this.deps.progressCadenceMs,
    );
  }

  /**
   * A sentence replaces the status line; null removes it. False when there was
   * no line or the surface refused the rewrite, and the caller must post instead.
   */
  private async endProgress(
    thread: Thread,
    line: string | null,
  ): Promise<boolean> {
    const progress = thread.progress;
    thread.progress = null;
    return progress ? progress.end(line) : false;
  }

  private freeSlots(): number {
    let held = 0;
    for (const thread of this.threads.values()) {
      if (HOLDING_A_SLOT.has(thread.state)) held += 1;
    }
    return this.deps.config.maxConcurrent - held;
  }

  private async mint(thread: Thread): Promise<void> {
    const { clock, sandboxes } = this.deps;
    this.to(thread, 'minting');
    this.disarmQuiet(thread);
    // The human's wait starts here, so the mint is timed from here.
    const asked = clock.now();
    let minted: MintedRef;
    try {
      minted = await sandboxes.mint(thread.ref, (step) =>
        thread.progress?.say(MINT_STEPS[step]),
      );
      thread.sandbox = minted;
    } catch (error) {
      // No sandbox exists, so the teardown that follows records nothing.
      this.metrics.minted('mint-failed');
      await this.failed(thread, `${MINT_FAILED}: ${plain(error)}`);
      return;
    }
    const ready = clock.now();
    const { source } = minted;
    const mintMs = ready - asked;
    thread.progress?.say(ATTACHING);
    try {
      const session = await sandboxes.attach(thread.sandbox);
      thread.session = session;
      thread.replay = !session.resumed;
    } catch (error) {
      // The mint finished, so its time is still recorded.
      this.metrics.minted('attach-failed', { source, mintMs });
      await this.failed(thread, `${ATTACH_FAILED}: ${plain(error)}`);
      return;
    }
    this.metrics.minted('ok', {
      source,
      mintMs,
      attachMs: clock.now() - ready,
    });
    this.to(thread, 'attached');
    await this.pump(thread);
  }

  private async failed(thread: Thread, line: string): Promise<void> {
    await this.tell(thread, line);
    this.drop(thread);
    await this.close(thread, { line: null, archive: false, reason: 'error' });
  }

  private enqueue(thread: Thread): void {
    this.waiting.push(thread.key);
    this.to(thread, 'waiting');
    const ahead = this.waiting.length - 1;
    thread.progress?.say(
      `${WAITING} · ${ahead > 0 ? `${ahead} ahead` : 'next up'}`,
    );
    this.armQuiet(thread);
  }

  private pumpWaiting(): void {
    while (this.freeSlots() > 0 && this.waiting.length > 0) {
      const next = this.threads.get(this.waiting.shift() ?? '');
      if (next?.state === 'waiting') void this.mint(next);
    }
  }

  private leaveQueue(thread: Thread): void {
    const at = this.waiting.indexOf(thread.key);
    if (at >= 0) this.waiting.splice(at, 1);
    this.disarmQuiet(thread);
    this.drop(thread);
    this.to(thread, 'closed');
  }

  private async runTurn(thread: Thread): Promise<void> {
    const { clock, sandboxes, log } = this.deps;
    const prompt = thread.pending.shift();
    if (!prompt || !thread.session) return;
    const refusal = this.budgetRefusal(thread);
    if (refusal) {
      this.mark(thread, [prompt], 'failed');
      this.drop(thread);
      await this.tell(thread, refusal);
      this.armQuiet(thread);
      return;
    }
    thread.turns += 1;
    thread.stopRequested = false;
    this.dayTurns.push(clock.now());
    this.metrics.turnStarted();
    this.to(thread, 'turn');
    this.disarmQuiet(thread);
    // The first await after the budget check and dayTurns push, so two turns
    // starting at once cannot both pass a cap with room for one.
    await this.endProgress(thread, null);

    const reply = new Reply(
      thread.surface.canvas(thread.ref, prompt.authorId),
      clock,
      log,
      thread.ref.id,
      this.deps.editCadenceMs ?? EDIT_CADENCE_MS,
      this.deps.runGraceMs ?? RUN_GRACE_MS,
    );
    reply.startWorking();
    try {
      const text = await this.withHistory(thread, prompt);
      if (thread.stopRequested) {
        thread.stopRequested = false;
        this.metrics.turnEnded('cancelled', {});
        await this.deliver(thread, reply, 'stopped');
        this.mark(thread, [prompt], 'stopped');
        return;
      }
      let result: PromptResult;
      try {
        result = await sandboxes.prompt(thread.session, text, reply);
      } catch (error) {
        this.metrics.turnEnded('sandbox-died', {});
        await this.deliver(thread, reply, 'failed');
        this.mark(thread, [prompt], 'failed');
        log.warn('sandbox died mid-turn', {
          threadId: thread.ref.id,
          error: plain(error),
        });
        await this.tell(thread, `${SANDBOX_DIED}: ${plain(error)}`);
        await this.close(thread, {
          line: null,
          archive: false,
          reason: 'error',
        });
        return;
      }
      this.metrics.turnEnded(result.stopReason, result);
      const outcome: Outcome =
        result.stopReason === 'error'
          ? 'failed'
          : result.stopReason === 'cancelled'
            ? 'stopped'
            : 'done';
      await this.deliver(thread, reply, outcome);
      this.mark(thread, [prompt], outcome);
      if (result.stopReason === 'error') {
        await this.tell(thread, `${HARNESS_FAILED}: ${plain(result.error)}`);
      }
    } finally {
      if (thread.state === 'turn') {
        this.to(thread, 'attached');
        await this.pump(thread);
      }
    }
  }

  /** Prefixes the thread's transcript to the first prompt of a session that did not resume. */
  private async withHistory(thread: Thread, prompt: Prompt): Promise<string> {
    if (!thread.replay) return prompt.text;
    thread.replay = false;
    const skip = [prompt.text, prompt.raw.trim()];
    for (const queued of thread.pending)
      skip.push(queued.text, queued.raw.trim());
    try {
      const preamble = await replayPreamble(thread.surface, thread.ref, {
        me: thread.surface.me,
        skip,
      });
      if (!preamble) return prompt.text;
      this.deps.log.info('replaying the thread transcript', {
        threadId: thread.ref.id,
        characters: preamble.length,
      });
      return `${preamble}${prompt.text}`;
    } catch (error) {
      this.deps.log.warn('transcript replay failed; the session starts empty', {
        threadId: thread.ref.id,
        error: plain(error),
      });
      return prompt.text;
    }
  }

  private async deliver(
    thread: Thread,
    reply: Reply,
    outcome: Outcome,
  ): Promise<void> {
    try {
      await reply.finish(outcome);
    } catch (error) {
      this.deps.log.warn('reply delivery failed', {
        threadId: thread.ref.id,
        error: plain(error),
      });
      await this.tell(thread, `${UNDELIVERED}: ${plain(error)}`);
    }
  }

  private drop(thread: Thread): void {
    this.mark(thread, thread.pending, 'failed');
    thread.pending = [];
  }

  /** Never awaited and never fatal: a turn neither waits for a reaction nor fails on one. */
  private mark(thread: Thread, prompts: readonly Prompt[], mark: Mark): void {
    const surface = thread.surface;
    if (!surface.mark) return;
    for (const { message } of prompts) {
      thread.marks = thread.marks
        .then(() => surface.mark?.(message, mark))
        .catch((error) =>
          this.deps.log.warn('a message could not be marked', {
            threadId: thread.ref.id,
            mark,
            error: plain(error),
          }),
        );
    }
  }

  private budgetRefusal(thread: Thread): string | null {
    const { config, clock } = this.deps;
    if (thread.turns >= config.maxTurnsPerThread) {
      return `${THREAD_SPENT} ${config.maxTurnsPerThread} turns — start a new thread`;
    }
    const floor = clock.now() - DAY_MS;
    while (this.dayTurns.length > 0 && (this.dayTurns[0] ?? 0) < floor) {
      this.dayTurns.shift();
    }
    if (this.dayTurns.length >= config.maxTurnsPerDay) {
      return `${DAY_SPENT} ${config.maxTurnsPerDay} turns is spent — try again later`;
    }
    return null;
  }

  private armQuiet(thread: Thread): void {
    this.disarmQuiet(thread);
    thread.quiet = this.deps.clock.after(this.deps.config.quietMs, () => {
      thread.quiet = null;
      void this.onQuiet(thread);
    });
  }

  private disarmQuiet(thread: Thread): void {
    if (thread.quiet) this.deps.clock.cancel(thread.quiet);
    thread.quiet = null;
  }

  private async onQuiet(thread: Thread): Promise<void> {
    if (thread.state === 'attached') {
      await this.close(thread, {
        line: SANDBOX_CLOSED,
        archive: true,
        reason: 'quiet',
      });
    } else if (thread.state === 'waiting') {
      this.leaveQueue(thread);
      await this.tell(thread, STOPPED_WAITING);
    }
  }

  private async close(
    thread: Thread,
    opts: { line: string | null; archive: boolean; reason: TeardownReason },
  ): Promise<void> {
    const { sandboxes, log } = this.deps;
    this.to(thread, 'tearing-down');
    this.disarmQuiet(thread);
    if (thread.sandbox) {
      await sandboxes.teardown(thread.sandbox).catch((error) =>
        log.warn('teardown failed', {
          threadId: thread.ref.id,
          error: plain(error),
        }),
      );
      this.metrics.teardown(opts.reason);
    }
    thread.sandbox = null;
    thread.session = null;
    thread.replay = false;
    this.to(thread, 'closed');
    if (opts.line) await this.tell(thread, opts.line);
    if (opts.archive && thread.pending.length === 0) {
      await thread.surface.archive?.(thread.ref).catch((error) =>
        log.warn('archive failed', {
          threadId: thread.ref.id,
          error: plain(error),
        }),
      );
    }
    this.pumpWaiting();
    if (thread.pending.length > 0) await this.pump(thread);
  }

  /** Posts one line, or rewrites the status line into it when one is up. */
  private async tell(thread: Thread, content: string): Promise<void> {
    if (await this.endProgress(thread, content)) return;
    await thread.surface.post(thread.ref, content).catch((error) =>
      this.deps.log.warn('message failed', {
        threadId: thread.ref.id,
        error: plain(error),
      }),
    );
  }
}
