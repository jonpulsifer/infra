/**
 * The sandbox interface, served by the in-process stub below or by the cluster
 * client in `sandboxes.ts`, as `MATE_SANDBOXES` chooses.
 */
import { type Clock, systemClock } from './clock.ts';
import type { ThreadRef, ToolCall } from './surface.ts';

export type { ThreadRef };

// The `source` label on the mint and attach histograms. Each value is a
// different cost; the pool is measured by `spare` against `fresh`.
export type SandboxSource = 'fresh' | 'reused' | 'spare';

export interface SandboxRef {
  /** Opaque: a sandbox taken from the spare pool is named after no thread. */
  readonly name: string;
  readonly thread: ThreadRef;
  /** Set by `list()` when the object says a turn was running: mate died under it. */
  readonly turnInFlight?: boolean;
  /** Absent on a ref `list()` rebuilt after a restart; every mint sets it. */
  readonly source?: SandboxSource;
}

export interface MintedRef extends SandboxRef {
  readonly source: SandboxSource;
}

export type MintStep =
  | 'reusing'
  | 'adopting'
  | 'refreshing'
  | 'creating'
  | 'booting';

export type OnMintStep = (step: MintStep) => void;

export interface Session {
  readonly id: string;
  readonly sandbox: SandboxRef;
  /** True when the harness replayed its own state; false when the session is empty. */
  readonly resumed: boolean;
}

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
  /** This turn's share of the session's ACP-reported cost, in USD. */
  costUsd?: number | null;
}

export interface Sandboxes {
  /** Every sandbox this mate owns, for rehydration after a restart. */
  list(): Promise<SandboxRef[]>;
  /** Resolves once the sandbox is Ready. */
  mint(thread: ThreadRef, onStep?: OnMintStep): Promise<MintedRef>;
  /** Does nothing when no pool is configured. */
  ensureSpares(): Promise<void>;
  /** Opens the ACP session (`session/load`, else `session/new`). */
  attach(sandbox: SandboxRef): Promise<Session>;
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
  /** Adoption's relabel and fetch, so a spare is not modelled as free. */
  spareDelayMs?: number;
  mintFails?: string;
  attachFails?: string;
  costUsd?: number;
  /** Models a harness that reloads its own session, as `session/load` does. */
  resumes?: boolean;
  /** Stands in for `MATE_SPARES`. */
  spares?: number;
}

export class StubSandboxes implements Sandboxes {
  private readonly clock: Clock;
  private readonly script: Script;
  private readonly live = new Map<string, SandboxRef>();
  private readonly cancelled = new Set<string>();
  private readonly running = new Set<string>();
  private readonly sessions = new Map<string, string>();
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

  /** Threads only, so rehydration never takes a spare for one. */
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

  async mint(thread: ThreadRef, onStep?: OnMintStep): Promise<MintedRef> {
    this.mints += 1;
    // Before `mintFails`, as on the cluster: a spare skips the mint path.
    const spare = this.warm.shift();
    if (spare) {
      onStep?.('adopting');
      await this.spareWait();
      onStep?.('refreshing');
      await this.spareWait();
      const taken = { name: spare, thread };
      this.live.set(spare, taken);
      void this.ensureSpares();
      return { ...taken, source: 'spare' };
    }
    // The delay below stands in for the boot, so both steps are announced
    // first.
    onStep?.('creating');
    onStep?.('booting');
    if (this.opts.mintDelayMs) await this.clock.sleep(this.opts.mintDelayMs);
    if (this.opts.mintFails) throw new Error(this.opts.mintFails);
    const ref = { name: `mate-${thread.id}`, thread };
    this.live.set(ref.name, ref);
    return { ...ref, source: 'fresh' };
  }

  private async spareWait(): Promise<void> {
    if (this.opts.spareDelayMs) await this.clock.sleep(this.opts.spareDelayMs);
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
