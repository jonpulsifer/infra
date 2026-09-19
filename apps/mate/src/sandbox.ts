/**
 * The sandbox side, behind one interface: the in-process stub below or the
 * agent-sandbox client in `sandboxes.ts`, chosen by `MATE_SANDBOXES`. The
 * thread engine only ever sees this.
 */
import { type Clock, systemClock } from './clock.ts';

export interface ThreadRef {
  readonly id: string;
  readonly channelId: string;
}

export interface SandboxRef {
  readonly name: string;
  readonly thread: ThreadRef;
  /** Set by `list()` when the object says a turn was running: mate died under it. */
  readonly turnInFlight?: boolean;
}

export interface Session {
  readonly id: string;
  readonly sandbox: SandboxRef;
  /** True when the harness replayed its own state; false when the session is empty. */
  readonly resumed: boolean;
}

export type Update =
  | { kind: 'text'; delta: string }
  | { kind: 'status'; line: string | null };

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
  /** Creates the thread's sandbox; resolves once it is Ready. */
  mint(thread: ThreadRef): Promise<SandboxRef>;
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
  mintFails?: string;
  attachFails?: string;
  costUsd?: number;
  /** Models a harness that reloads its own session, as `session/load` does. */
  resumes?: boolean;
}

export class StubSandboxes implements Sandboxes {
  private readonly clock: Clock;
  private readonly script: Script;
  private readonly live = new Map<string, SandboxRef>();
  private readonly cancelled = new Set<string>();
  private readonly running = new Set<string>();
  private readonly sessions = new Map<string, string>();
  /** Mutable so a test can fail an attach on a sandbox that already exists. */
  attachFails: string | null;
  /** Every prompt text the harness was handed, replay preamble included. */
  readonly prompts: string[] = [];
  private serial = 0;
  private mints = 0;

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

  async list(): Promise<SandboxRef[]> {
    return [...this.live.values()].map((ref) => ({
      ...ref,
      turnInFlight: this.running.has(ref.name),
    }));
  }

  async mint(thread: ThreadRef): Promise<SandboxRef> {
    this.mints += 1;
    if (this.opts.mintDelayMs) await this.clock.sleep(this.opts.mintDelayMs);
    if (this.opts.mintFails) throw new Error(this.opts.mintFails);
    const ref = { name: `mate-${thread.id}`, thread };
    this.live.set(ref.name, ref);
    return ref;
  }

  async attach(sandbox: SandboxRef): Promise<Session> {
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
