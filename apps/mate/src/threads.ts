/**
 * The thread state machine: one Discord thread owns at most one sandbox, and
 * every transition in the state table lives here. Discord and the sandbox
 * side are both ports, so the whole contract runs against fakes.
 */
import type { Clock, Handle } from './clock.ts';
import type { Config } from './config.ts';
import type { Discord } from './discord.ts';
import { type Log, plain } from './log.ts';
import {
  type Instruments,
  lazyInstruments,
  type TeardownReason,
} from './metrics.ts';
import {
  ATTACH_FAILED,
  DAY_SPENT,
  HARNESS_FAILED,
  MINT_FAILED,
  RESTARTED,
  SANDBOX_CLOSED,
  SANDBOX_DIED,
  STOPPED_WAITING,
  THREAD_SPENT,
  UNDELIVERED,
  WAITING,
} from './notices.ts';
import { EDIT_CADENCE_MS, type Outcome, Reply } from './reply.ts';
import type {
  PromptResult,
  Sandboxes,
  SandboxRef,
  Session,
} from './sandbox.ts';
import { replayPreamble } from './transcript.ts';

export type ThreadState =
  | 'new'
  | 'waiting'
  | 'minting'
  | 'attached'
  | 'turn'
  | 'tearing-down'
  | 'closed'
  | 'rehydrating';

export interface Inbound {
  id: string;
  guildId: string | null;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  mentionsMe: boolean;
}

interface Prompt {
  text: string;
  raw: string;
  authorId: string;
}

interface Thread {
  id: string;
  channelId: string;
  state: ThreadState;
  sandbox: SandboxRef | null;
  session: Session | null;
  pending: Prompt[];
  turns: number;
  quiet: Handle | null;
  /** Set while the thread's harness has never been told what came before. */
  replay: boolean;
  /** Set by a Stop that lands before the turn reaches the harness. */
  stopRequested: boolean;
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
  | 'guildId'
  | 'allowedUserIds'
  | 'allowedChannelIds'
  | 'quietMs'
  | 'maxTurnsPerThread'
  | 'maxTurnsPerDay'
  | 'maxConcurrent'
>;

export interface ThreadsDeps {
  discord: Discord;
  sandboxes: Sandboxes;
  clock: Clock;
  log: Log;
  config: ThreadsConfig;
  /** The bot user's id. */
  me: string;
  editCadenceMs?: number;
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
  private readonly waiting: string[] = [];
  private readonly dayTurns: number[] = [];
  private readonly backlog: Inbound[] = [];
  private readonly metrics: Instruments;
  private hydrating = false;

  constructor(private readonly deps: ThreadsDeps) {
    this.metrics = deps.metrics ?? lazyInstruments();
  }

  stateOf(threadId: string): ThreadState | undefined {
    return this.threads.get(threadId)?.state;
  }

  get waitingIds(): readonly string[] {
    return this.waiting;
  }

  /** A thread mate owns from an earlier life: known, and closed until spoken to. */
  adopt(threadId: string, channelId: string): void {
    this.ensure(threadId, channelId);
  }

  /**
   * Re-attaches to the sandboxes found at start. Messages that land meanwhile
   * are held and handled afterwards, so a thread is never minted twice.
   */
  async rehydrate(): Promise<void> {
    const { sandboxes, log } = this.deps;
    this.hydrating = true;
    try {
      for (const sandbox of await sandboxes.list()) {
        const thread = this.ensure(sandbox.thread.id, sandbox.thread.channelId);
        if (thread.state !== 'new') {
          log.warn('rehydrate skipped a thread already in motion', {
            threadId: thread.id,
            state: thread.state,
          });
          continue;
        }
        thread.sandbox = sandbox;
        this.to(thread, 'rehydrating');
        // The object says a turn was running when the process died, and the
        // human is owed the reason their answer never arrived.
        if (sandbox.turnInFlight) await this.tell(thread, RESTARTED);
        try {
          const session = await sandboxes.attach(sandbox);
          thread.session = session;
          thread.replay = !session.resumed;
          this.to(thread, 'attached');
          await this.pump(thread);
        } catch (error) {
          log.warn('rehydrate failed; tearing down', {
            threadId: thread.id,
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
    const { config, discord, log, me } = this.deps;
    if (message.authorIsBot || message.guildId !== config.guildId) return;
    if (this.hydrating) {
      this.backlog.push(message);
      return;
    }
    const prompt = {
      text: stripMention(message.content, me),
      raw: message.content,
      authorId: message.authorId,
    };
    const known = this.threads.get(message.channelId);
    if (known) {
      this.accept(known, prompt);
      return;
    }
    if (
      !config.allowedChannelIds.has(message.channelId) ||
      !message.mentionsMe ||
      !config.allowedUserIds.has(message.authorId)
    ) {
      return;
    }
    let threadId: string;
    try {
      threadId = await discord.createThread(
        message.channelId,
        message.id,
        threadName(message.content, me),
      );
    } catch (error) {
      log.warn('thread create failed', {
        channelId: message.channelId,
        messageId: message.id,
        error: plain(error),
      });
      return;
    }
    const thread = this.ensure(threadId, message.channelId);
    this.accept(thread, prompt);
  }

  async onStop(
    threadId: string,
    userId: string,
    ack: () => Promise<void>,
  ): Promise<void> {
    const { config, sandboxes, log } = this.deps;
    await ack().catch((error) =>
      log.warn('stop ack failed', { threadId, error: plain(error) }),
    );
    const thread = this.threads.get(threadId);
    if (!thread || !config.allowedUserIds.has(userId)) return;
    if (thread.state !== 'turn') return;
    // A turn still reading the thread's transcript has nothing to cancel yet,
    // so the flag is what stops it; the harness only hears about one it holds.
    thread.stopRequested = true;
    if (thread.session) await sandboxes.cancel(thread.session);
  }

  async onThreadArchived(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (thread.state === 'attached') {
      await this.close(thread, {
        line: SANDBOX_CLOSED,
        archive: true,
        reason: 'archived',
      });
    } else if (thread.state === 'waiting') {
      this.leaveQueue(thread);
    }
  }

  async onThreadDeleted(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    this.threads.delete(threadId);
    this.disarmQuiet(thread);
    const at = this.waiting.indexOf(threadId);
    if (at >= 0) this.waiting.splice(at, 1);
    if (thread.sandbox) {
      await this.deps.sandboxes.teardown(thread.sandbox).catch(() => {});
      this.metrics.teardown('thread-deleted');
    }
    this.deps.log.info('thread deleted', {
      threadId,
      sandbox: thread.sandbox?.name ?? null,
      turns: thread.turns,
    });
    this.report();
    this.pumpWaiting();
  }

  private ensure(threadId: string, channelId: string): Thread {
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        channelId,
        state: 'new',
        sandbox: null,
        session: null,
        pending: [],
        turns: 0,
        quiet: null,
        replay: false,
        stopRequested: false,
      };
      this.threads.set(threadId, thread);
    }
    return thread;
  }

  /** The one place a thread changes state, so every move leaves a line. */
  private to(thread: Thread, state: ThreadState): void {
    thread.state = state;
    this.deps.log.info('thread state', {
      threadId: thread.id,
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
    this.disarmQuiet(thread);
    void this.pump(thread);
  }

  private async pump(thread: Thread): Promise<void> {
    try {
      switch (thread.state) {
        case 'new':
        case 'closed':
          if (thread.pending.length === 0) return;
          if (this.freeSlots() > 0) await this.mint(thread);
          else await this.enqueue(thread);
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
        threadId: thread.id,
        state: thread.state,
        error: plain(error),
      });
    }
  }

  private freeSlots(): number {
    let held = 0;
    for (const thread of this.threads.values()) {
      if (HOLDING_A_SLOT.has(thread.state)) held += 1;
    }
    return this.deps.config.maxConcurrent - held;
  }

  private async mint(thread: Thread): Promise<void> {
    const { sandboxes } = this.deps;
    this.to(thread, 'minting');
    this.disarmQuiet(thread);
    try {
      thread.sandbox = await sandboxes.mint({
        id: thread.id,
        channelId: thread.channelId,
      });
    } catch (error) {
      await this.failed(thread, `${MINT_FAILED}: ${plain(error)}`);
      return;
    }
    try {
      const session = await sandboxes.attach(thread.sandbox);
      thread.session = session;
      thread.replay = !session.resumed;
    } catch (error) {
      await this.failed(thread, `${ATTACH_FAILED}: ${plain(error)}`);
      return;
    }
    this.to(thread, 'attached');
    await this.pump(thread);
  }

  /** One plain sentence, the queued prompts dropped, and whatever exists torn down. */
  private async failed(thread: Thread, line: string): Promise<void> {
    await this.tell(thread, line);
    thread.pending = [];
    await this.close(thread, { line: null, archive: false, reason: 'error' });
  }

  private async enqueue(thread: Thread): Promise<void> {
    this.waiting.push(thread.id);
    this.to(thread, 'waiting');
    await this.tell(thread, `${WAITING} (${this.waiting.length - 1} ahead)`);
    this.armQuiet(thread);
  }

  private pumpWaiting(): void {
    while (this.freeSlots() > 0 && this.waiting.length > 0) {
      const next = this.threads.get(this.waiting.shift() ?? '');
      if (next?.state === 'waiting') void this.mint(next);
    }
  }

  private leaveQueue(thread: Thread): void {
    const at = this.waiting.indexOf(thread.id);
    if (at >= 0) this.waiting.splice(at, 1);
    this.disarmQuiet(thread);
    thread.pending = [];
    this.to(thread, 'closed');
  }

  private async runTurn(thread: Thread): Promise<void> {
    const { clock, discord, sandboxes, log } = this.deps;
    const prompt = thread.pending.shift();
    if (!prompt || !thread.session) return;
    const refusal = this.budgetRefusal(thread);
    if (refusal) {
      thread.pending = [];
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

    const reply = new Reply(
      discord,
      clock,
      log,
      thread.id,
      this.deps.editCadenceMs ?? EDIT_CADENCE_MS,
    );
    reply.startTyping();
    try {
      const text = await this.withHistory(thread, prompt);
      if (thread.stopRequested) {
        thread.stopRequested = false;
        this.metrics.turnEnded('cancelled', {});
        await this.deliver(thread, reply, 'stopped');
        return;
      }
      let result: PromptResult;
      try {
        result = await sandboxes.prompt(thread.session, text, reply);
      } catch (error) {
        this.metrics.turnEnded('sandbox-died', {});
        await this.deliver(thread, reply, 'failed');
        log.warn('sandbox died mid-turn', {
          threadId: thread.id,
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
      if (result.stopReason === 'error') {
        await this.deliver(thread, reply, 'failed');
        await this.tell(thread, `${HARNESS_FAILED}: ${plain(result.error)}`);
      } else {
        await this.deliver(
          thread,
          reply,
          result.stopReason === 'cancelled' ? 'stopped' : 'done',
        );
      }
    } finally {
      if (thread.state === 'turn') {
        this.to(thread, 'attached');
        await this.pump(thread);
      }
    }
  }

  /**
   * The first prompt of a session the harness could not reload carries the
   * thread's own history: Discord is the durable log, and a harness that
   * starts empty would otherwise answer as if nothing had been said.
   */
  private async withHistory(thread: Thread, prompt: Prompt): Promise<string> {
    if (!thread.replay) return prompt.text;
    thread.replay = false;
    const skip = [prompt.text, prompt.raw.trim()];
    for (const queued of thread.pending)
      skip.push(queued.text, queued.raw.trim());
    try {
      const preamble = await replayPreamble(this.deps.discord, thread.id, {
        me: this.deps.me,
        skip,
      });
      if (!preamble) return prompt.text;
      this.deps.log.info('replaying the thread transcript', {
        threadId: thread.id,
        characters: preamble.length,
      });
      return `${preamble}${prompt.text}`;
    } catch (error) {
      this.deps.log.warn('transcript replay failed; the session starts empty', {
        threadId: thread.id,
        error: plain(error),
      });
      return prompt.text;
    }
  }

  /** Lands the reply's final state; a failure is one line in the thread, never a stuck turn. */
  private async deliver(
    thread: Thread,
    reply: Reply,
    outcome: Outcome,
  ): Promise<void> {
    try {
      await reply.finish(outcome);
    } catch (error) {
      this.deps.log.warn('reply delivery failed', {
        threadId: thread.id,
        error: plain(error),
      });
      await this.tell(thread, `${UNDELIVERED}: ${plain(error)}`);
    }
  }

  private budgetRefusal(thread: Thread): string | null {
    const { config, clock } = this.deps;
    if (thread.turns >= config.maxTurnsPerThread) {
      return `${THREAD_SPENT} ${config.maxTurnsPerThread} turns; start a new thread`;
    }
    const floor = clock.now() - DAY_MS;
    while (this.dayTurns.length > 0 && (this.dayTurns[0] ?? 0) < floor) {
      this.dayTurns.shift();
    }
    if (this.dayTurns.length >= config.maxTurnsPerDay) {
      return `${DAY_SPENT} ${config.maxTurnsPerDay} turns is spent; try again later`;
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
    const { discord, sandboxes, log } = this.deps;
    this.to(thread, 'tearing-down');
    this.disarmQuiet(thread);
    if (thread.sandbox) {
      await sandboxes.teardown(thread.sandbox).catch((error) =>
        log.warn('teardown failed', {
          threadId: thread.id,
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
      await discord.archiveThread(thread.id).catch((error) =>
        log.warn('archive failed', {
          threadId: thread.id,
          error: plain(error),
        }),
      );
    }
    this.pumpWaiting();
    if (thread.pending.length > 0) await this.pump(thread);
  }

  private async tell(thread: Thread, content: string): Promise<void> {
    await this.deps.discord
      .createMessage(thread.id, { content })
      .catch((error) =>
        this.deps.log.warn('message failed', {
          threadId: thread.id,
          error: plain(error),
        }),
      );
  }
}
