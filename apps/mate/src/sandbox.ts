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
}

export interface Session {
  readonly id: string;
  readonly sandbox: SandboxRef;
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
}

export class StubSandboxes implements Sandboxes {
  private readonly clock: Clock;
  private readonly script: Script;
  private readonly live = new Map<string, SandboxRef>();
  private readonly cancelled = new Set<string>();
  private serial = 0;
  private mints = 0;

  constructor(private readonly opts: StubOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.script = opts.script ?? echoScript;
  }

  get liveCount(): number {
    return this.live.size;
  }

  get mintCount(): number {
    return this.mints;
  }

  async list(): Promise<SandboxRef[]> {
    return [...this.live.values()];
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
    if (!this.live.has(sandbox.name)) {
      throw new Error(`sandbox ${sandbox.name} is gone`);
    }
    this.serial += 1;
    return { id: `stub-session-${this.serial}`, sandbox };
  }

  async prompt(
    session: Session,
    text: string,
    sink: PromptSink,
  ): Promise<PromptResult> {
    this.cancelled.delete(session.id);
    for (const step of this.script(text)) {
      if (this.cancelled.has(session.id)) return { stopReason: 'cancelled' };
      if (!this.live.has(session.sandbox.name)) {
        throw new Error(`sandbox ${session.sandbox.name} died mid-turn`);
      }
      if ('wait' in step) await this.clock.sleep(step.wait);
      else if ('text' in step) sink.update({ kind: 'text', delta: step.text });
      else if ('status' in step)
        sink.update({ kind: 'status', line: step.status });
      else return { stopReason: 'error', error: step.fail };
    }
    if (this.cancelled.has(session.id)) return { stopReason: 'cancelled' };
    return { stopReason: 'end_turn' };
  }

  async cancel(session: Session): Promise<void> {
    this.cancelled.add(session.id);
  }

  async teardown(sandbox: SandboxRef): Promise<void> {
    this.live.delete(sandbox.name);
  }
}
