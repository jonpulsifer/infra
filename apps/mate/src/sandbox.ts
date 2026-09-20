/**
 * The sandbox side, behind one interface: the in-process stub below or the
 * agent-sandbox client in `sandboxes.ts`, chosen by `MATE_SANDBOXES`. The
 * thread engine only ever sees this.
 */
import { type Clock, systemClock } from './clock.ts';
import type { ThreadRef, ToolCall } from './surface.ts';

export type { ThreadRef };

/**
 * Which of three waits a thread paid for its sandbox, and the `source` label
 * on `mate_mint_duration_milliseconds` and `mate_attach_duration_milliseconds`.
 * They are three series rather than two because they are three different
 * costs: a `fresh` mint pays a kata VM boot and a clone, which is the cold
 * start being chased; `reused` is this thread's own sandbox from an earlier
 * turn and pays neither; and `spare` is one the warm pool was already
 * holding, which pays a relabel and a shallow fetch instead. Folding the last
 * two together would hide exactly the difference the pool exists to make.
 */
export type SandboxSource = 'fresh' | 'reused' | 'spare';

export interface SandboxRef {
  /** Opaque: a sandbox taken from the spare pool is named after no thread. */
  readonly name: string;
  readonly thread: ThreadRef;
  /** Set by `list()` when the object says a turn was running: mate died under it. */
  readonly turnInFlight?: boolean;
  /**
   * Absent on a ref `list()` rebuilt from an object that outlived a restart,
   * because no thread waited for that one. Every mint sets it, which is what
   * `MintedRef` says.
   */
  readonly source?: SandboxSource;
}

/** What a mint hands back: the ref, and which wait the thread just paid. */
export interface MintedRef extends SandboxRef {
  readonly source: SandboxSource;
}

export interface Session {
  readonly id: string;
  readonly sandbox: SandboxRef;
  /** True when the harness replayed its own state; false when the session is empty. */
  readonly resumed: boolean;
}

/**
 * What a turn tells the renderer as it runs. `status` and `tool` are the same
 * news said two ways — the line a surface paints itself, and the call a
 * surface that has cards of its own renders one by one — so a harness emits
 * both and each surface takes the one it can show.
 */
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
  /** This turn's share of the session's ACP-reported cost, in USD. */
  costUsd?: number | null;
}

export interface Sandboxes {
  /** Every sandbox this mate owns, for rehydration after a restart. */
  list(): Promise<SandboxRef[]>;
  /**
   * Creates the thread's sandbox, claims the one it already has, or takes one
   * the warm pool was holding; resolves once it is Ready.
   */
  mint(thread: ThreadRef): Promise<MintedRef>;
  /**
   * Tops the warm spare pool up to what is configured and renews what is
   * already in it. Called on a cadence and after a thread takes a spare, and
   * with no pool configured it does nothing at all.
   */
  ensureSpares(): Promise<void>;
  /** Opens the ACP session (`session/load`, else `session/new`). */
  attach(sandbox: SandboxRef): Promise<Session>;
  /** One turn: streams updates into the sink, resolves when the turn ends. */
  prompt(
    session: Session,
    text: string,
    sink: PromptSink,
  ): Promise<PromptResult>;
  cancel(session: Session): Promise<void>;
  teardown(sandbox: SandboxRef): Promise<void>;
}

export type Step =
  | { text: string }
  | { status: string | null }
  | { tool: ToolCall }
  | { wait: number }
  | { fail: string };

export type Script = (prompt: string) => Step[];

export const echoScript: Script = (prompt) => {
  const words = prompt.split(/\s+/).filter(Boolean);
  const steps: Step[] = [{ status: 'running `echo`…' }, { wait: 300 }];
  steps.push({ text: 'you said: ' });
  for (const word of words) steps.push({ text: `${word} ` }, { wait: 120 });
  steps.push({ status: null });
  return steps;
};

export interface StubOptions {
  clock?: Clock;
  script?: Script;
  mintDelayMs?: number;
  attachDelayMs?: number;
  mintFails?: string;
  attachFails?: string;
  costUsd?: number;
  /** Models a harness that reloads its own session, as `session/load` does. */
  resumes?: boolean;
  /** The stub's side of `MATE_SPARES`: how many sandboxes `ensureSpares()` keeps warm. */
  spares?: number;
}

export class StubSandboxes implements Sandboxes {
  private readonly clock: Clock;
  private readonly script: Script;
  private readonly live = new Map<string, SandboxRef>();
  private readonly cancelled = new Set<string>();
  private readonly running = new Set<string>();
  private readonly sessions = new Map<string, string>();
  /** Warm and unclaimed: named, but belonging to no thread until a mint takes one. */
  private readonly warm: string[] = [];
  /** Mutable so a test can fail an attach on a sandbox that already exists. */
  attachFails: string | null;
  /** Every prompt text the harness was handed, replay preamble included. */
  readonly prompts: string[] = [];
  private serial = 0;
  private mints = 0;
  private spares = 0;

  constructor(private readonly opts: StubOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.script = opts.script ?? echoScript;
    this.attachFails = opts.attachFails ?? null;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get mintCount(): number {
    return this.mints;
  }

  get spareCount(): number {
    return this.warm.length;
  }

  /** Threads only: a spare is not one, and rehydration must not take it for one. */
  async list(): Promise<SandboxRef[]> {
    return [...this.live.values()].map((ref) => ({
      ...ref,
      turnInFlight: this.running.has(ref.name),
    }));
  }

  async ensureSpares(): Promise<void> {
    while (this.warm.length < (this.opts.spares ?? 0)) {
      if (this.opts.mintDelayMs) await this.clock.sleep(this.opts.mintDelayMs);
      this.warm.push(`mate-spare-${++this.spares}`);
    }
  }

  async mint(thread: ThreadRef): Promise<MintedRef> {
    this.mints += 1;
    // Ahead of `mintFails`, and faithfully so: a thread that takes a spare
    // never reaches the path that a broken mint breaks.
    const spare = this.warm.shift();
    if (spare) {
      // The whole of what a spare buys: the wait a fresh one pays is one
      // somebody already paid, and the name it was born with stays its name.
      const taken = { name: spare, thread };
      this.live.set(spare, taken);
      void this.ensureSpares();
      return { ...taken, source: 'spare' };
    }
    if (this.opts.mintDelayMs) await this.clock.sleep(this.opts.mintDelayMs);
    if (this.opts.mintFails) throw new Error(this.opts.mintFails);
    const ref = { name: `mate-${thread.id}`, thread };
    this.live.set(ref.name, ref);
    return { ...ref, source: 'fresh' };
  }

  async attach(sandbox: SandboxRef): Promise<Session> {
    if (this.opts.attachDelayMs)
      await this.clock.sleep(this.opts.attachDelayMs);
    if (this.attachFails) throw new Error(this.attachFails);
    if (!this.live.has(sandbox.name)) {
      throw new Error(`sandbox ${sandbox.name} is gone`);
    }
    this.running.delete(sandbox.name);
    const stored = this.sessions.get(sandbox.name);
    if (stored && this.opts.resumes) {
      return { id: stored, sandbox, resumed: true };
    }
    this.serial += 1;
    const id = `stub-session-${this.serial}`;
    this.sessions.set(sandbox.name, id);
    return { id, sandbox, resumed: false };
  }

  async prompt(
    session: Session,
    text: string,
    sink: PromptSink,
  ): Promise<PromptResult> {
    const name = session.sandbox.name;
    this.cancelled.delete(session.id);
    this.running.add(name);
    this.prompts.push(text);
    const startedAt = this.clock.now();
    let firstTokenMs: number | null = null;
    for (const step of this.script(text)) {
      if (this.cancelled.has(session.id)) return this.ended(name, 'cancelled');
      if (!this.live.has(name)) {
        throw new Error(`sandbox ${name} died mid-turn`);
      }
      if ('wait' in step) await this.clock.sleep(step.wait);
      else if ('text' in step) {
        firstTokenMs ??= this.clock.now() - startedAt;
        sink.update({ kind: 'text', delta: step.text });
      } else if ('status' in step)
        sink.update({ kind: 'status', line: step.status });
      else if ('tool' in step) sink.update({ kind: 'tool', call: step.tool });
      else return this.ended(name, 'error', { error: step.fail });
    }
    if (this.cancelled.has(session.id)) return this.ended(name, 'cancelled');
    return this.ended(name, 'end_turn', {
      firstTokenMs,
      costUsd: this.opts.costUsd ?? null,
    });
  }

  private ended(
    name: string,
    stopReason: StopReason,
    rest: Omit<PromptResult, 'stopReason'> = {},
  ): PromptResult {
    this.running.delete(name);
    return { stopReason, ...rest };
  }

  async cancel(session: Session): Promise<void> {
    this.cancelled.add(session.id);
  }

  async teardown(sandbox: SandboxRef): Promise<void> {
    this.live.delete(sandbox.name);
    this.running.delete(sandbox.name);
    this.sessions.delete(sandbox.name);
  }
}
