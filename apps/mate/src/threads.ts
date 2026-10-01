/**
 * The thread state machine. The concurrency caps, the queues and the daily turn
 * budgets span every surface, one lane for interactive profiles and one for
 * the rest. Each thread's memory lives in the brain's store; this engine owns
 * its row in `mate_threads` and the turns it runs.
 */
import {
  type Brain,
  type BrainSession,
  BrainUnavailable,
  TurnAbandoned,
} from './brain-port.ts';
import type { Clock, Handle } from './clock.ts';
import type { Config } from './config.ts';
import type { TeardownReason } from './lease.ts';
import { type Log, plain } from './log.ts';
import { type Instruments, lazyInstruments, type StoreOp } from './metrics.ts';
import {
  DAY_SPENT,
  GAVE_UP_WAITING,
  HARNESS_FAILED,
  NEVER_STARTED,
  PROFILE_GONE,
  PROFILE_PLACE,
  PROFILE_UNKNOWN,
  RECORD_GONE,
  RESTARTED,
  RESUMING,
  RUNS_AS,
  STORE_DOWN,
  THREAD_CLOSED,
  THREAD_SPENT,
  TURN_WAITING,
  UNDELIVERED,
  UNRUN,
} from './notices.ts';
import {
  AUTOMATION_CONCURRENCY,
  DEFAULT_PROFILE,
  LANES,
  type Lane,
  laneOf,
  PROFILES,
  type Profile,
  profileTag,
  strayTag,
  sweepable,
} from './profiles.ts';
import { Progress } from './progress.ts';
import { EDIT_CADENCE_MS, Reply, RUN_GRACE_MS } from './reply.ts';
import type { PromptResult } from './sandbox.ts';
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
import type {
  ThreadRow,
  ThreadRowPatch,
  ThreadStore,
  TurnMark,
} from './thread-store.ts';
import { assignmentPost, replayPreamble } from './transcript.ts';

export type { Inbound };

/** A trusted trigger's thread. */
export interface Start {
  readonly ref: ThreadRef;
  /** An automation or job profile. */
  readonly profile: string;
  /** On the surface's allowlist: Slack's stream recipient and the turn mark's asker. */
  readonly asker: string;
  readonly text: string;
}

export type ThreadState =
  | 'new'
  | 'waiting'
  | 'opening'
  | 'idle'
  | 'turn'
  | 'releasing'
  | 'closed'
  | 'rehydrating';

interface Prompt {
  text: string;
  raw: string;
  authorId: string;
  message: MessageRef;
  /** The profile this message's own `+id` asked for, checked against the row. */
  readonly asked: string | null;
}

interface Thread {
  /** Unique across every surface. */
  key: string;
  ref: ThreadRef;
  surface: Surface;
  /** The row's once it loads; until then the profile the thread was created under. */
  profile: Profile;
  state: ThreadState;
  row: ThreadRow | null;
  session: BrainSession | null;
  pending: Prompt[];
  turns: number;
  quiet: Handle | null;
  /** The status line shown while the thread waits for a turn. */
  progress: Progress | null;
  /** Set when the session did not resume; the next prompt carries the transcript. */
  replay: boolean;
  /** Catches a Stop that arrives before the prompt reaches the brain. */
  stopRequested: boolean;
  /**
   * Serializes marks: a turn refused on arrival marks its message twice in
   * one tick, and applied out of order the stale mark would stay.
   */
  marks: Promise<void>;
  /** The running turn or resume, with every write after it. */
  task: Promise<void> | null;
  restoreAttempts: number;
  /** Set once the thread is deleted, so a turn ending late writes nothing. */
  removed: boolean;
  /** A job restored before its first turn: its release says so. */
  unrun: boolean;
}

export const THREAD_NAME_MAX = 100;
/** Resumes of one turn before a restart discards it instead. */
export const MAX_RESUMES = 2;
export const RESTORE_RETRY_MS = 30_000;
export const RESTORE_ATTEMPTS = 10;
/** SIGTERM: how long running turns may take to finish on their own. */
export const DRAIN_MS = 20_000;
export const ABANDON_MS = 8_000;
export const ABANDON_WAIT_MS = 3_000;
const DAY_MS = 86_400_000;

/**
 * A turn slot is held while a thread opens or runs a turn, and while a thread
 * restored at boot still has a cut-off turn to resume or settle.
 */
function holdsSlot(thread: Thread): boolean {
  return (
    thread.state === 'opening' ||
    thread.state === 'turn' ||
    (thread.state === 'rehydrating' && Boolean(thread.row?.turn))
  );
}

/** Where a command came from, and so where its answers go. */
export interface CommandContext {
  readonly surface: Surface;
  readonly thread: ThreadRef;
  readonly authorId: string;
}

export interface Command {
  run(context: CommandContext): Promise<void>;
}

/** Commands to mate itself, which never reach the brain or take a turn. */
export interface Commands {
  /** The command a whole message names, its mention stripped, or null for a prompt. */
  parse(text: string): Command | null;
}

export type ThreadsConfig = Pick<
  Config,
  'quietMs' | 'maxTurnsPerThread' | 'maxTurnsPerDay' | 'maxConcurrent'
>;

export interface ThreadsDeps {
  surfaces: readonly Surface[];
  brain: Brain;
  store: ThreadStore;
  /** Resolves when the store comes up; a failed rehydrate runs again then. */
  storeReady?: Promise<void>;
  /** Threads whose pre-cutover sandbox had a turn in flight. */
  inherited?: readonly ThreadRef[];
  clock: Clock;
  log: Log;
  config: ThreadsConfig;
  editCadenceMs?: number;
  /** How long a run of text is a step before it becomes the answer. */
  runGraceMs?: number;
  progressCadenceMs?: number;
  metrics?: Instruments;
  commands?: Commands;
  /** Tests add an automation profile; PROFILES otherwise. */
  profiles?: ReadonlyMap<string, Profile>;
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

function misplaced(stray: string): string {
  return `${PROFILE_PLACE} start the message with +${stray}`;
}

function keeps(profile: string, asked: string): string {
  return `${RUNS_AS} ${profile} — a thread keeps the profile it opened with; start a new thread for +${asked}`;
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class Threads {
  private readonly threads = new Map<string, Thread>();
  private readonly surfaces = new Map<SurfaceName, Surface>();
  private readonly waiting: Record<Lane, string[]> = {
    interactive: [],
    automation: [],
  };
  private readonly dayTurns: number[] = [];
  private readonly backlog: Inbound[] = [];
  private readonly inheritedTold = new Set<string>();
  /**
   * Threads mate opened only to refuse a `+id`, with the refusal: never
   * adopted, and a message in one is refused again.
   */
  private readonly refused = new Map<string, string>();
  private readonly metrics: Instruments;
  private readonly profiles: ReadonlyMap<string, Profile>;
  private readonly byDefault: Profile;
  private hydrating = 0;
  private storeUp = false;
  private draining = false;
  /** SIGTERM answered the queue; a message from here on is answered at once. */
  private quiesced = false;
  /** Slots of deleted threads whose turn the brain has not let go of yet. */
  private readonly forgetting: Record<Lane, number> = {
    interactive: 0,
    automation: 0,
  };

  constructor(private readonly deps: ThreadsDeps) {
    this.metrics = deps.metrics ?? lazyInstruments();
    this.profiles = deps.profiles ?? PROFILES;
    const byDefault = this.profiles.get(DEFAULT_PROFILE);
    if (!byDefault) throw new Error(`no profile ${DEFAULT_PROFILE}`);
    this.byDefault = byDefault;
    for (const surface of deps.surfaces) {
      this.surfaces.set(surface.name, surface);
    }
    void deps.storeReady?.then(() => {
      this.storeUp = true;
    });
  }

  stateOf(key: string): ThreadState | undefined {
    return this.threads.get(key)?.state;
  }

  get waitingIds(): readonly string[] {
    return [...this.waiting.interactive, ...this.waiting.automation];
  }

  get surfaceNames(): SurfaceName[] {
    return [...this.surfaces.keys()];
  }

  /** Registers a thread from before a restart, so a reply in it needs no mention. */
  adopt(ref: ThreadRef): void {
    if (this.refused.has(threadKey(ref))) return;
    const surface = this.surfaces.get(ref.surface);
    if (surface) this.ensure(surface, ref);
  }

  /**
   * Surfaces connect independently, so each rehydrates only its own threads.
   * Returns once the rows are in memory; opens and resumes run behind it.
   */
  async add(surface: Surface): Promise<void> {
    this.surfaces.set(surface.name, surface);
    await this.rehydrate(surface.name);
  }

  /**
   * Loads the open rows, `only` one surface's when given, then opens each in
   * the background. Messages that arrive meanwhile wait until the rows are in.
   */
  async rehydrate(only?: SurfaceName): Promise<void> {
    const { store, log } = this.deps;
    this.hydrating += 1;
    try {
      let rows: ThreadRow[];
      try {
        rows = await store.list({ state: 'open', surface: only });
      } catch (error) {
        log.warn('rehydrate could not list the threads; it runs again', {
          surface: only ?? null,
          error: plain(error),
        });
        this.metrics.storeFailed('rows');
        this.retryRehydrate(only);
        return;
      }
      const restoring: Thread[] = [];
      for (const row of rows) {
        const surface = this.surfaces.get(row.ref.surface);
        if (!surface) continue;
        const profile = this.profiles.get(row.profile);
        if (!profile) {
          log.error('a thread names a profile this mate does not declare', {
            threadId: row.ref.id,
            profile: row.profile,
          });
          // Logged once: a reply reopens it under an image that declares it.
          await store.patch(row.key, { state: 'closed' }).catch((error) => {
            this.metrics.storeFailed('rows');
            log.warn('a thread row could not be written', {
              threadId: row.ref.id,
              error: plain(error),
            });
          });
          continue;
        }
        const thread = this.ensure(surface, row.ref, profile);
        if (thread.state !== 'new') {
          log.warn('rehydrate skipped a thread already in motion', {
            threadId: thread.ref.id,
            state: thread.state,
          });
          continue;
        }
        thread.profile = profile;
        thread.row = row;
        thread.turns = row.turns;
        // A start cut off between its row and its turn.
        thread.unrun = profile.mode === 'job' && row.turns === 0 && !row.turn;
        this.to(thread, 'rehydrating');
        restoring.push(thread);
      }
      const known = new Set(rows.map((row) => row.key));
      for (const ref of this.deps.inherited ?? []) {
        if (only && ref.surface !== only) continue;
        const key = threadKey(ref);
        if (known.has(key) || this.inheritedTold.has(key)) continue;
        this.inheritedTold.add(key);
        void this.restarted(ref);
      }
      void this.restore(restoring);
    } finally {
      this.hydrating -= 1;
      if (this.hydrating === 0) {
        for (const message of this.backlog.splice(0)) {
          await this.onMessage(message);
        }
      }
    }
  }

  /**
   * A trusted internal trigger: opens a thread under an automation or job
   * profile and queues `text`. The row is the attempt: once it exists no
   * trigger starts this thread again, so a refused or failed first turn is
   * told once in the thread, never on every tick. Bot-authored Slack events
   * must never enter onMessage. False when the thread exists.
   */
  async start({ ref, profile: id, asker, text }: Start): Promise<boolean> {
    const surface = this.surfaces.get(ref.surface);
    if (
      !surface?.allowedChannelIds.has(ref.channelId) ||
      !surface.allowedUserIds.has(asker)
    ) {
      throw new Error('a start has no authorized destination or owner');
    }
    const profile = this.profiles.get(id);
    if (!profile || profile.mode === 'interactive') {
      throw new Error(`a start runs an automation or job profile, not ${id}`);
    }
    if (this.draining || this.quiesced)
      throw new Error('mate is shutting down');
    const thread = this.ensure(surface, ref, profile);
    if (thread.row || thread.pending.length > 0 || thread.state !== 'new') {
      return false;
    }
    if (await this.deps.store.get(thread.key)) return false;
    thread.profile = profile;
    const row = await this.deps.store.open(ref, profile.id);
    thread.row = row;
    thread.turns = row.turns;
    // In the thread, so a replay after the session is set aside still has it.
    await surface.post(ref, assignmentPost(text)).catch((error) =>
      this.deps.log.warn('the assignment could not be posted', {
        threadId: ref.id,
        error: plain(error),
      }),
    );
    if (thread.pending.length > 0 || thread.state !== 'new') return false;
    this.accept(thread, {
      text,
      raw: text,
      authorId: asker,
      asked: null,
      message: { channelId: ref.channelId, id: ref.id },
    });
    return true;
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
    if (this.hydrating > 0) {
      this.backlog.push(message);
      return;
    }
    const stripped = stripMention(message.content, surface.me);
    // The tag rides this prompt, so no later message changes what it asked for.
    const tag = profileTag(stripped);
    const prompt: Prompt = {
      text: tag ? tag.text : stripped,
      raw: message.content,
      authorId: message.authorId,
      message: { channelId: message.channelId, id: message.id },
      asked: tag?.id ?? null,
    };
    const stray = tag ? null : strayTag(prompt.text, this.profiles.keys());
    const command = this.deps.commands?.parse(prompt.text) ?? null;
    const inside: ThreadRef | null = message.threadId
      ? {
          surface: surface.name,
          channelId: message.channelId,
          id: message.threadId,
        }
      : null;
    const refusal = inside && this.refused.get(threadKey(inside));
    if (inside && refusal) {
      await this.refuse(surface, inside, prompt.message, refusal);
      return;
    }
    const known = inside ? this.threads.get(threadKey(inside)) : undefined;
    if (known) {
      const line = this.knownRefusal(known, tag?.id ?? null, stray);
      if (line) {
        this.mark(known, [prompt.message], 'failed');
        await this.say(known.surface, known.ref, line);
        return;
      }
      if (command) this.command(command, known, message.authorId);
      else this.accept(known, prompt);
      return;
    }
    if (
      !surface.allowedChannelIds.has(message.channelId) ||
      !message.mentionsMe
    ) {
      return;
    }
    let profile = this.byDefault;
    let line: string | null = null;
    if (stray) line = misplaced(stray);
    else if (tag) {
      const asked = this.profiles.get(tag.id);
      if (asked?.mode === 'interactive') profile = asked;
      else line = this.unknown(tag.id);
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
    if (line) {
      // A Slack mention inside a thread mate holds no Thread for, perhaps one
      // with a closed row: refuse this message, not the thread.
      if (message.threadId && ref.id === message.threadId) {
        await this.refuse(surface, ref, prompt.message, line);
        return;
      }
      // Before any await: Discord's ThreadCreate can adopt the thread first.
      const key = threadKey(ref);
      this.refused.set(key, line);
      const early = this.threads.get(key);
      if (early && !early.row && early.pending.length === 0) {
        this.threads.delete(key);
      }
      await this.refuse(surface, ref, prompt.message, line);
      // So a restarted mate does not adopt it.
      await surface
        .archive?.(ref)
        .catch((error) =>
          log.warn('archive failed', { threadId: ref.id, error: plain(error) }),
        );
      return;
    }
    const thread = this.ensure(surface, ref, profile);
    // Discord's ThreadCreate can adopt the thread first, under the default.
    if (!thread.row && thread.pending.length === 0) thread.profile = profile;
    if (command) this.command(command, thread, message.authorId);
    else this.accept(thread, prompt);
  }

  /** Why a message in a known thread runs nothing: its `+id` cannot run here. */
  private knownRefusal(
    thread: Thread,
    asked: string | null,
    stray: string | null,
  ): string | null {
    const loaded = Boolean(thread.row);
    if (stray && !(loaded && thread.profile.id === stray)) {
      return misplaced(stray);
    }
    if (!asked) return null;
    if (this.profiles.get(asked)?.mode !== 'interactive') {
      return this.unknown(asked);
    }
    if (loaded && thread.profile.id !== asked) {
      return keeps(thread.profile.id, asked);
    }
    return null;
  }

  private unknown(asked: string): string {
    const chat = [...this.profiles.values()]
      .filter((profile) => profile.mode === 'interactive')
      .map((profile) => `+${profile.id}`)
      .join(', ');
    return `${PROFILE_UNKNOWN} +${asked} — open one with ${chat}`;
  }

  /** A thread that holds no Thread: the line, and its message marked failed. */
  private async refuse(
    surface: Surface,
    ref: ThreadRef,
    message: MessageRef,
    line: string,
  ): Promise<void> {
    await this.say(surface, ref, line);
    await surface.mark?.(message, 'failed').catch((error) =>
      this.deps.log.warn('a message could not be marked', {
        threadId: ref.id,
        mark: 'failed',
        error: plain(error),
      }),
    );
  }

  /** Posts one line and leaves any status line where it is. */
  private async say(
    surface: Surface,
    ref: ThreadRef,
    line: string,
  ): Promise<void> {
    await surface.post(ref, line).catch((error) =>
      this.deps.log.warn('message failed', {
        threadId: ref.id,
        error: plain(error),
      }),
    );
  }

  /** Runs beside any turn, and a failure is only logged. */
  private command(command: Command, thread: Thread, authorId: string): void {
    void command
      .run({ surface: thread.surface, thread: thread.ref, authorId })
      .catch((error) =>
        this.deps.log.warn('a command failed', {
          threadId: thread.ref.id,
          error: plain(error),
        }),
      );
  }

  async onStop(
    key: string,
    userId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    const { brain, log } = this.deps;
    await ack().catch((error) =>
      log.warn('stop ack failed', { threadId: key, error: plain(error) }),
    );
    const thread = this.threads.get(key);
    if (!thread?.surface.allowedUserIds.has(userId)) return;
    if (thread.state !== 'turn') return;
    // A turn still building its prompt has nothing in the brain to cancel.
    thread.stopRequested = true;
    if (thread.session) await brain.cancel(thread.session);
  }

  async onThreadArchived(ref: ThreadRef): Promise<void> {
    const thread = this.threads.get(threadKey(ref));
    if (!thread) return;
    if (thread.state === 'idle') {
      await this.release(thread, 'archived', { line: null, archive: true });
    } else if (thread.state === 'waiting') {
      await this.leaveQueue(thread, 'archived');
      // The thread is archived, so nobody would read a closing sentence.
      await this.endProgress(thread, null);
    }
  }

  async onThreadDeleted(ref: ThreadRef): Promise<void> {
    const { brain, store, log } = this.deps;
    const key = threadKey(ref);
    const thread = this.threads.get(key);
    if (!thread) return;
    this.threads.delete(key);
    thread.removed = true;
    const held = holdsSlot(thread);
    const lane = laneOf(thread.profile);
    if (held) this.forgetting[lane] += 1;
    this.disarmQuiet(thread);
    // The line's redraw timer outlives the thread, so end it here.
    await this.endProgress(thread, null);
    this.unqueue(key);
    this.report();
    try {
      await brain.forget(ref);
    } finally {
      if (held) this.forgetting[lane] -= 1;
    }
    await store
      .delete(key)
      .catch((error) => this.storeFailed(thread, 'rows', error));
    if (held) this.pumpWaiting();
    log.info('thread deleted', {
      surface: ref.surface,
      threadId: ref.id,
      turns: thread.turns,
    });
  }

  /**
   * SIGTERM: lets running turns finish within `ms`, then has the brain
   * abandon the rest, whose runs stay open for the next process to resume.
   * Queued prompts are told they never started.
   */
  async drain(ms: number): Promise<void> {
    this.draining = true;
    await this.within(this.tasks(), ms);
    await this.within(this.deps.brain.abandon(), ABANDON_MS);
    await this.within(this.tasks(), ABANDON_WAIT_MS);
    await this.quiesce();
  }

  /**
   * Answers every prompt still queued, so no line claims mate is about to
   * start. A kill skips this, which is why no line promises an answer.
   */
  async quiesce(): Promise<void> {
    this.quiesced = true;
    for (const thread of this.threads.values()) {
      if (thread.pending.length > 0) {
        this.drop(thread);
        await this.tell(thread, NEVER_STARTED);
      } else if (thread.progress) {
        await this.endProgress(thread, NEVER_STARTED);
      }
    }
  }

  private tasks(): Promise<unknown> {
    const running = [...this.threads.values()].flatMap((thread) =>
      thread.task ? [thread.task] : [],
    );
    return Promise.allSettled(running);
  }

  /** Waits for `work`, or `ms` on the clock, whichever is first. */
  private async within(work: Promise<unknown>, ms: number): Promise<void> {
    if (ms <= 0) return;
    const { clock } = this.deps;
    let timer: Handle | null = null;
    const timeout = new Promise<void>((resolve) => {
      timer = clock.after(ms, resolve);
    });
    await Promise.race([work.then(() => undefined), timeout]);
    if (timer) clock.cancel(timer);
  }

  /** `profile` is the thread's only when this creates it. */
  private ensure(
    surface: Surface,
    ref: ThreadRef,
    profile: Profile = this.byDefault,
  ): Thread {
    const key = threadKey(ref);
    let thread = this.threads.get(key);
    if (!thread) {
      thread = {
        key,
        ref,
        surface,
        profile,
        state: 'new',
        row: null,
        session: null,
        pending: [],
        turns: 0,
        quiet: null,
        progress: null,
        replay: false,
        stopRequested: false,
        marks: Promise.resolve(),
        task: null,
        restoreAttempts: 0,
        removed: false,
        unrun: false,
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
      turns: thread.turns,
    });
    this.report();
  }

  private report(): void {
    const running: Record<Lane, number> = { interactive: 0, automation: 0 };
    for (const thread of this.threads.values()) {
      if (thread.state === 'turn') running[laneOf(thread.profile)] += 1;
    }
    for (const lane of LANES) {
      this.metrics.turnsRunning(running[lane], lane);
      this.metrics.queueDepth(this.waiting[lane].length, lane);
    }
  }

  private accept(thread: Thread, prompt: Prompt): void {
    if (this.quiesced) {
      this.mark(thread, [prompt.message], 'failed');
      void this.tell(thread, NEVER_STARTED);
      return;
    }
    thread.pending.push(prompt);
    this.mark(thread, [prompt.message], 'seen');
    this.disarmQuiet(thread);
    void this.pump(thread);
  }

  private async pump(thread: Thread): Promise<void> {
    if (this.draining || thread.removed) return;
    try {
      switch (thread.state) {
        case 'new':
        case 'closed':
          if (thread.pending.length === 0) return;
          if (this.canStart(thread)) await this.open(thread);
          else this.enqueue(thread);
          return;
        case 'idle':
          if (thread.pending.length === 0) this.rest(thread);
          else if (this.canStart(thread)) await this.runTurn(thread);
          else this.enqueue(thread);
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

  /** A slot of the thread's lane is free and nobody is ahead in its queue. */
  private canStart(thread: Thread): boolean {
    const lane = laneOf(thread.profile);
    return this.freeSlots(lane) > 0 && this.waiting[lane].length === 0;
  }

  private freeSlots(lane: Lane): number {
    let held = 0;
    for (const thread of this.threads.values()) {
      if (holdsSlot(thread) && laneOf(thread.profile) === lane) held += 1;
    }
    const slots =
      lane === 'interactive'
        ? this.deps.config.maxConcurrent
        : AUTOMATION_CONCURRENCY;
    return slots - held - this.forgetting[lane];
  }

  /** Runs after every event that frees a turn slot; each queue's head goes first. */
  private pumpWaiting(): void {
    if (this.draining) return;
    for (const lane of LANES) {
      const queue = this.waiting[lane];
      while (this.freeSlots(lane) > 0 && queue.length > 0) {
        const next = this.threads.get(queue.shift() ?? '');
        if (next?.state !== 'waiting') continue;
        if (next.session) void this.runTurn(next);
        else void this.open(next);
      }
    }
    this.report();
  }

  private unqueue(key: string): void {
    for (const lane of LANES) {
      const at = this.waiting[lane].indexOf(key);
      if (at >= 0) this.waiting[lane].splice(at, 1);
    }
  }

  private enqueue(thread: Thread): void {
    const queue = this.waiting[laneOf(thread.profile)];
    queue.push(thread.key);
    this.to(thread, 'waiting');
    const ahead = queue.length - 1;
    const line = `${TURN_WAITING} · ${ahead > 0 ? `${ahead} ahead` : 'next up'}`;
    if (thread.progress) thread.progress.say(line);
    else {
      thread.progress = new Progress(
        thread.surface.notice(thread.ref),
        this.deps.clock,
        this.deps.log,
        thread.ref.id,
        line,
        this.deps.progressCadenceMs,
      );
    }
    this.armQuiet(thread);
  }

  private async leaveQueue(thread: Thread, reason: TeardownReason) {
    this.unqueue(thread.key);
    this.disarmQuiet(thread);
    this.drop(thread);
    if (thread.session) {
      await this.release(thread, reason, { line: null, archive: false });
      return;
    }
    // A started job's row, opened before its turn could.
    if (thread.row?.state === 'open') {
      await this.patch(thread, { state: 'closed' });
    }
    this.to(thread, 'closed');
  }

  /**
   * A slot is held from here: the row, then the session. A store that is down
   * is one plain line, and the thread goes back to `new`. The stored row's
   * profile wins, so a refused open never marks a row open.
   */
  private async open(thread: Thread): Promise<void> {
    const { brain, store } = this.deps;
    this.to(thread, 'opening');
    this.disarmQuiet(thread);
    let session: BrainSession;
    try {
      const asked = thread.pending[0]?.asked ?? null;
      const stored = await store.get(thread.key);
      if (thread.removed) return;
      const id = stored?.profile ?? asked ?? thread.profile.id;
      if (asked && id !== asked) {
        return await this.refuseProfile(thread, keeps(id, asked));
      }
      const profile = this.profiles.get(id);
      if (!profile) {
        return await this.refuseProfile(thread, `${PROFILE_GONE} ${id}`);
      }
      // Only `start` births a non-interactive row; chat never does, even for
      // a thread whose row was swept.
      if (!stored && profile.mode !== 'interactive') {
        if (!sweepable(this.profiles).includes(id)) {
          return await this.refuseProfile(thread, RECORD_GONE);
        }
        // Swept with the default's grants: born again as the default, in its
        // lane, as after a restart.
        thread.profile = this.byDefault;
        this.to(thread, 'new');
        this.pumpWaiting();
        return await this.pump(thread);
      }
      const row = await store.open(thread.ref, profile.id);
      if (thread.removed) {
        // The delete ran while the row opened, so the open wrote it back.
        await store
          .delete(thread.key)
          .catch((error) => this.storeFailed(thread, 'rows', error));
        return;
      }
      thread.profile = profile;
      thread.row = row;
      thread.turns = row.turns;
      if (asked && asked !== DEFAULT_PROFILE && row.turns === 0) {
        await this.tell(thread, `${RUNS_AS} ${profile.id}`);
        // The delete ran during the post, and its forget found no open to wait on.
        if (thread.removed) return;
      }
      // A delete from here on forgets the thread after this open settles.
      session = await brain.open(row);
    } catch (error) {
      if (!thread.removed) await this.storeDown(thread, error);
      return;
    }
    if (thread.removed) return;
    this.opened(thread, session);
  }

  private async storeDown(thread: Thread, error: unknown): Promise<void> {
    this.deps.log.warn('the thread could not be opened', {
      threadId: thread.ref.id,
      error: plain(error),
    });
    if (!(error instanceof BrainUnavailable)) {
      this.metrics.storeFailed('open');
    }
    this.drop(thread);
    this.to(thread, 'new');
    this.pumpWaiting();
    await this.tell(thread, STORE_DOWN);
  }

  /** Like `storeDown`: the row's profile is not the one asked for, or cannot open here. */
  private async refuseProfile(thread: Thread, line: string): Promise<void> {
    this.drop(thread);
    this.to(thread, 'new');
    this.pumpWaiting();
    await this.tell(thread, line);
  }

  /**
   * The open rule, at boot and for every later open: resume a run a restart
   * cut off while its budget lasts, else discard it; an answer lost with no
   * run to resume is said so.
   */
  private opened(thread: Thread, session: BrainSession): void {
    thread.session = session;
    thread.replay = !session.resumed;
    // SIGTERM: the row and its mark stay as they are for the next mate's rule.
    if (this.draining) {
      this.to(thread, 'idle');
      return;
    }
    const mark = thread.row?.turn ?? null;
    if (session.interrupted && mark && mark.resumes < MAX_RESUMES) {
      thread.task = this.resume(thread, session, mark);
    } else if (session.interrupted || mark) {
      thread.task = this.settleLost(thread, session, mark);
    } else {
      void this.settled(thread, thread.state === 'opening');
    }
  }

  /** An open that held a turn slot runs its prompt at once; any other waits its turn. */
  private async settled(thread: Thread, opening: boolean): Promise<void> {
    this.to(thread, 'idle');
    if (opening && thread.pending.length > 0) {
      await this.runTurn(thread);
      return;
    }
    this.pumpWaiting();
    await this.pump(thread);
  }

  private async settleLost(
    thread: Thread,
    session: BrainSession,
    mark: TurnMark | null,
  ): Promise<void> {
    const opening = thread.state === 'opening';
    if (session.interrupted) {
      await this.deps.brain.discard(session);
      this.metrics.turnResumed('discarded');
    } else {
      this.metrics.turnResumed('lost');
    }
    thread.session = { ...session, interrupted: null };
    await this.tell(thread, RESTARTED);
    await thread.surface.settle?.(thread.ref).catch((error) =>
      this.deps.log.warn('settle failed', {
        threadId: thread.ref.id,
        error: plain(error),
      }),
    );
    if (mark) {
      this.mark(thread, [mark.message], 'failed');
      await this.patch(thread, { turn: null });
    }
    thread.task = null;
    if (!thread.removed) await this.settled(thread, opening);
  }

  /** Drives the interrupted run into a fresh card for the person it answers. */
  private async resume(
    thread: Thread,
    session: BrainSession,
    mark: TurnMark,
  ): Promise<void> {
    const { brain, clock, log } = this.deps;
    this.to(thread, 'turn');
    this.disarmQuiet(thread);
    thread.stopRequested = false;
    // Before the resume runs, so one that crashes mate is not retried forever.
    await this.patch(thread, { turn: { ...mark, resumes: mark.resumes + 1 } });
    await this.tell(thread, RESUMING);
    await thread.surface.settle?.(thread.ref).catch((error) =>
      log.warn('settle failed', {
        threadId: thread.ref.id,
        error: plain(error),
      }),
    );
    const reply = this.reply(thread, mark.asker);
    reply.startWorking();
    let result: PromptResult;
    try {
      const running = brain.resume({ ...session }, reply, {
        asker: mark.asker,
        message: mark.message,
      });
      if (thread.stopRequested) void brain.cancel(session);
      result = await running;
    } catch (error) {
      if (error instanceof TurnAbandoned) {
        // SIGTERM stopped this resume, so it gets its try back: the budget
        // counts only the resumes that took mate down with them.
        await this.patch(thread, { turn: mark });
        return;
      }
      await this.brainFailed(thread, reply, [mark.message], error);
      await this.turnDone(thread);
      return;
    }
    thread.session = { ...session, interrupted: null, resumed: true };
    this.metrics.turnResumed('resumed');
    await this.ended(thread, reply, [mark.message], result);
    log.info('resumed a turn a restart cut off', {
      threadId: thread.ref.id,
      stopReason: result.stopReason,
      waitedMs: clock.now() - mark.startedAt,
    });
    await this.turnDone(thread);
  }

  private async runTurn(thread: Thread): Promise<void> {
    const { clock } = this.deps;
    // SIGTERM: the prompt stays queued for `quiesce` to answer.
    if (this.draining) return;
    const prompt = thread.pending.shift();
    if (!prompt || !thread.session) return;
    thread.unrun = false;
    // A tagged prompt queued while the thread opened or before its row loaded.
    const refusal =
      prompt.asked && prompt.asked !== thread.profile.id
        ? keeps(thread.profile.id, prompt.asked)
        : this.budgetRefusal(thread);
    if (refusal) {
      this.mark(thread, [prompt.message], 'failed');
      this.drop(thread);
      await this.tell(thread, refusal);
      this.to(thread, 'idle');
      this.pumpWaiting();
      this.rest(thread);
      return;
    }
    thread.turns += 1;
    thread.stopRequested = false;
    if (thread.profile.mode === 'interactive') this.dayTurns.push(clock.now());
    this.to(thread, 'turn');
    this.disarmQuiet(thread);
    const task = this.turn(thread, prompt);
    thread.task = task;
    await task;
  }

  private async turn(thread: Thread, prompt: Prompt): Promise<void> {
    const { brain, clock } = this.deps;
    const session = thread.session;
    if (!session) return;
    const { profile } = thread;
    const cap = profile.budget.turnsPerDay;
    // The first await after the budget check and dayTurns push, so two turns
    // starting at once cannot both pass a cap with room for one. A profile's
    // own day cap is claimed in the store, atomic across processes.
    if (cap !== null) {
      let refusal: string | null = null;
      try {
        if (
          !(await this.deps.store.claimTurn(
            profile.id,
            utcDay(clock.now()),
            cap,
          ))
        ) {
          refusal = `${DAY_SPENT} ${cap} ${profile.id} turns is spent — it resets at 00:00 UTC`;
        }
      } catch (error) {
        this.storeFailed(thread, 'rows', error);
        refusal = STORE_DOWN;
      }
      if (refusal) {
        thread.turns -= 1;
        this.mark(thread, [prompt.message], 'failed');
        this.drop(thread);
        await this.tell(thread, refusal);
        await this.turnDone(thread);
        return;
      }
    }
    this.metrics.turnStarted(profile.id, profile.mode);
    await this.patch(thread, {
      turns: thread.turns,
      turn: {
        asker: prompt.authorId,
        message: prompt.message,
        startedAt: clock.now(),
        resumes: 0,
      },
    });
    await this.endProgress(thread, null);
    const reply = this.reply(thread, prompt.authorId);
    reply.startWorking();
    let result: PromptResult;
    try {
      const text = await this.withHistory(thread, prompt);
      if (thread.stopRequested) {
        thread.stopRequested = false;
        this.metrics.turnEnded('cancelled', {});
        await this.deliver(thread, reply, 'stopped');
        this.mark(thread, [prompt.message], 'stopped');
        await this.turnDone(thread);
        return;
      }
      result = await brain.prompt(session, text, reply, {
        asker: prompt.authorId,
        message: prompt.message,
      });
    } catch (error) {
      if (error instanceof TurnAbandoned) return;
      await this.brainFailed(thread, reply, [prompt.message], error);
      await this.turnDone(thread);
      return;
    }
    thread.session = { ...session, resumed: !result.reset };
    if (result.reset) thread.replay = true;
    await this.ended(thread, reply, [prompt.message], result);
    await this.turnDone(thread);
  }

  private reply(thread: Thread, asker: string): Reply {
    return new Reply(
      thread.surface.canvas(thread.ref, asker),
      this.deps.clock,
      this.deps.log,
      thread.ref.id,
      this.deps.editCadenceMs ?? EDIT_CADENCE_MS,
      this.deps.runGraceMs ?? RUN_GRACE_MS,
    );
  }

  private async ended(
    thread: Thread,
    reply: Reply,
    messages: readonly MessageRef[],
    result: PromptResult,
  ): Promise<void> {
    this.metrics.turnEnded(result.stopReason, result);
    const outcome: Outcome =
      result.stopReason === 'error'
        ? 'failed'
        : result.stopReason === 'cancelled'
          ? 'stopped'
          : 'done';
    await this.deliver(thread, reply, outcome);
    this.mark(thread, messages, outcome);
    if (result.stopReason === 'error') {
      await this.tell(thread, `${HARNESS_FAILED}: ${plain(result.error)}`);
    }
    if (result.notice) await this.tell(thread, result.notice);
  }

  private async brainFailed(
    thread: Thread,
    reply: Reply,
    messages: readonly MessageRef[],
    error: unknown,
  ): Promise<void> {
    this.metrics.turnEnded('brain-failed', {});
    await this.deliver(thread, reply, 'failed');
    this.mark(thread, messages, 'failed');
    this.deps.log.warn('the brain failed mid-turn', {
      threadId: thread.ref.id,
      error: plain(error),
    });
    await this.tell(
      thread,
      error instanceof BrainUnavailable
        ? STORE_DOWN
        : `${HARNESS_FAILED}: ${plain(error)}`,
    );
  }

  /** Every turn and resume ends here, unless SIGTERM abandoned it. */
  private async turnDone(thread: Thread): Promise<void> {
    thread.task = null;
    if (thread.removed) return;
    await this.patch(thread, { turn: null });
    this.to(thread, 'idle');
    this.pumpWaiting();
    await this.pump(thread);
  }

  /** Prefixes the thread's transcript to the first prompt of a session that did not resume. */
  private async withHistory(thread: Thread, prompt: Prompt): Promise<string> {
    if (!thread.replay) return prompt.text;
    thread.replay = false;
    const skip = [prompt.text, prompt.raw.trim()];
    for (const queued of thread.pending)
      skip.push(queued.text, queued.raw.trim());
    try {
      const { commands } = this.deps;
      const me = thread.surface.me;
      const preamble = await replayPreamble(thread.surface, thread.ref, {
        me,
        skip,
        command: commands
          ? (text) => commands.parse(stripMention(text, me)) !== null
          : undefined,
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
    this.mark(
      thread,
      thread.pending.map((prompt) => prompt.message),
      'failed',
    );
    thread.pending = [];
  }

  /** Never awaited and never fatal: a turn neither waits for a reaction nor fails on one. */
  private mark(
    thread: Thread,
    messages: readonly MessageRef[],
    mark: Mark,
  ): void {
    const surface = thread.surface;
    if (!surface.mark) return;
    for (const message of messages) {
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

  /** Best effort: the row is bookkeeping, and a failed write never fails a turn. */
  private async patch(thread: Thread, patch: ThreadRowPatch): Promise<void> {
    if (thread.removed) return;
    try {
      await this.deps.store.patch(thread.key, patch);
      if (thread.row) thread.row = { ...thread.row, ...patch } as ThreadRow;
    } catch (error) {
      this.storeFailed(thread, 'rows', error);
    }
  }

  private storeFailed(thread: Thread, op: StoreOp, error: unknown): void {
    this.metrics.storeFailed(op);
    this.deps.log.warn('a thread row could not be written', {
      threadId: thread.ref.id,
      error: plain(error),
    });
  }

  private budgetRefusal(thread: Thread): string | null {
    const { config, clock } = this.deps;
    const perThread =
      thread.profile.budget.turnsPerThread ?? config.maxTurnsPerThread;
    if (thread.turns >= perThread) {
      return `${THREAD_SPENT} ${perThread} turns — start a new thread`;
    }
    // Other profiles claim their own day in `turn`.
    if (thread.profile.mode !== 'interactive') return null;
    const floor = clock.now() - DAY_MS;
    while (this.dayTurns.length > 0 && (this.dayTurns[0] ?? 0) < floor) {
      this.dayTurns.shift();
    }
    if (this.dayTurns.length >= config.maxTurnsPerDay) {
      return `${DAY_SPENT} ${config.maxTurnsPerDay} turns is spent — try again later`;
    }
    return null;
  }

  /** An idle thread with nothing queued: a job is done, any other waits for quiet. */
  private rest(thread: Thread): void {
    if (thread.profile.mode !== 'job') {
      this.armQuiet(thread);
      return;
    }
    const line = thread.unrun ? UNRUN : null;
    thread.unrun = false;
    void this.release(thread, 'finished', { line, archive: true });
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
    if (thread.state === 'idle') {
      await this.release(thread, 'quiet', {
        line: THREAD_CLOSED,
        archive: true,
      });
    } else if (thread.state === 'waiting') {
      await this.leaveQueue(thread, 'quiet');
      await this.tell(thread, GAVE_UP_WAITING);
    }
  }

  /** Gives the sandbox back and closes the row; the stored session stays. */
  private async release(
    thread: Thread,
    reason: TeardownReason,
    close: { line: string | null; archive: boolean },
  ): Promise<void> {
    const { brain, log } = this.deps;
    this.to(thread, 'releasing');
    this.disarmQuiet(thread);
    await brain.release(thread.ref, reason);
    await this.patch(thread, { state: 'closed' });
    thread.session = null;
    thread.replay = false;
    this.to(thread, 'closed');
    if (close.line) await this.tell(thread, close.line);
    if (close.archive && thread.pending.length === 0) {
      await thread.surface.archive?.(thread.ref).catch((error) =>
        log.warn('archive failed', {
          threadId: thread.ref.id,
          error: plain(error),
        }),
      );
    }
    if (thread.pending.length > 0) await this.pump(thread);
  }

  /** A thread with a row that is still open is retried; one with no mark is left for its next message. */
  private async restore(threads: readonly Thread[]): Promise<void> {
    for (const thread of threads) await this.restoreOne(thread);
  }

  private async restoreOne(thread: Thread): Promise<void> {
    const { brain, log, clock } = this.deps;
    if (
      this.draining ||
      thread.removed ||
      thread.state !== 'rehydrating' ||
      !thread.row
    ) {
      return;
    }
    let session: BrainSession;
    try {
      session = await brain.open(thread.row);
    } catch (error) {
      if (thread.removed || thread.state !== 'rehydrating') return;
      thread.restoreAttempts += 1;
      log.warn('a thread could not be restored', {
        threadId: thread.ref.id,
        attempt: thread.restoreAttempts,
        error: plain(error),
      });
      if (!thread.row.turn) {
        this.to(thread, 'new');
        await this.pump(thread);
        return;
      }
      if (thread.restoreAttempts < RESTORE_ATTEMPTS) {
        clock.after(RESTORE_RETRY_MS, () => void this.restoreOne(thread));
        return;
      }
      this.mark(thread, [thread.row.turn.message], 'failed');
      this.drop(thread);
      this.to(thread, 'new');
      this.pumpWaiting();
      await this.tell(thread, STORE_DOWN);
      return;
    }
    if (thread.removed) return;
    this.opened(thread, session);
  }

  private retryRehydrate(only: SurfaceName | undefined): void {
    const again = () => void this.rehydrate(only);
    if (!this.storeUp && this.deps.storeReady) {
      void this.deps.storeReady.then(again);
      return;
    }
    this.deps.clock.after(RESTORE_RETRY_MS, again);
  }

  /** A pre-cutover sandbox had a turn in flight here; its answer is lost. */
  private async restarted(ref: ThreadRef): Promise<void> {
    const surface = this.surfaces.get(ref.surface);
    if (!surface) return;
    const thread = this.ensure(surface, ref);
    await this.tell(thread, RESTARTED);
    await surface.settle?.(ref).catch((error) =>
      this.deps.log.warn('settle failed', {
        threadId: ref.id,
        error: plain(error),
      }),
    );
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
}
