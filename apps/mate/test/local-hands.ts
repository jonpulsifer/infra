/**
 * Hands over a local directory: pi's `NodeExecutionEnv` stands in for the
 * sandbox, and each turn's lease is scripted. It records what the brain asked
 * of it, in order, so a test can tell a chat-only turn from a tool turn.
 */
import {
  type Context,
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
} from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import type {
  Hands,
  LeaseEvent,
  TeardownReason,
  ThreadHands,
  ThreadHandsHooks,
  TurnLease,
  TurnLeaseOptions,
  TurnLeaseSummary,
} from '../src/lease.ts';
import { type ThreadRef, threadKey } from '../src/surface.ts';

/** Methods that answer without a sandbox. */
const LOCAL = new Set(['cwd', 'absolutePath', 'joinPath', 'cleanup']);

export interface LocalHandsOptions {
  /** The directory every thread's env works in. */
  readonly root: string;
  /** What a lease reports on its first call in a turn. */
  readonly events?: readonly LeaseEvent[];
  /** Holds a call until the promise settles, when it returns one. */
  readonly hold?: (method: string, args: unknown[]) => Promise<void> | null;
}

export class LocalHands implements Hands {
  /** In order: `acquire`, `exec-aborted`, `finish`, `abandon`, `warm`, `release:<reason>`. */
  readonly log: string[] = [];
  readonly calls: { method: string; path: string | null }[] = [];
  readonly released: { key: string; reason: TeardownReason }[] = [];
  private readonly threads = new Map<string, LocalThreadHands>();

  constructor(readonly options: LocalHandsOptions) {}

  get acquisitions(): number {
    return this.log.filter((entry) => entry === 'acquire').length;
  }

  thread(ref: ThreadRef, hooks: ThreadHandsHooks): ThreadHands {
    const key = threadKey(ref);
    const known = this.threads.get(key);
    if (known) {
      known.hooks = hooks;
      return known;
    }
    const made = new LocalThreadHands(this, key, hooks);
    this.threads.set(key, made);
    return made;
  }

  /** The hands of a thread, as the brain holds them. */
  of(key: string): LocalThreadHands | undefined {
    return this.threads.get(key);
  }

  async release(ref: ThreadRef, reason: TeardownReason): Promise<void> {
    const key = threadKey(ref);
    this.released.push({ key, reason });
    this.log.push(`release:${reason}`);
    const thread = this.threads.get(key);
    if (thread?.sandbox) thread.hooks.onSandboxGone(reason);
    this.threads.delete(key);
  }

  async ensureSpares(): Promise<void> {}

  async start(): Promise<readonly ThreadRef[]> {
    return [];
  }

  async shutdown(): Promise<void> {
    for (const thread of this.threads.values()) await thread.lease?.abandon();
  }
}

export class LocalThreadHands implements ThreadHands {
  readonly env: ExecutionEnv;
  lease: LocalLease | null = null;
  sandbox: string | null = null;

  constructor(
    readonly owner: LocalHands,
    readonly key: string,
    public hooks: ThreadHandsHooks,
  ) {
    this.env = this.facade(new NodeExecutionEnv({ cwd: owner.options.root }));
  }

  beginTurn(options: TurnLeaseOptions): TurnLease {
    if (this.lease && !this.lease.over) {
      throw new Error('a lease is already open for this thread');
    }
    this.lease = new LocalLease(this, options);
    return this.lease;
  }

  /** Every call but the local ones takes the lease first, as the real hands do. */
  private facade(node: NodeExecutionEnv): ExecutionEnv {
    return new Proxy(node, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || LOCAL.has(String(property))) {
          return typeof value === 'function' ? value.bind(target) : value;
        }
        const method = String(property);
        return async (...args: unknown[]) => {
          const context = args.at(-1) as Context;
          const path = typeof args[0] === 'string' ? args[0] : null;
          this.owner.calls.push({ method, path });
          const failure = await (this.lease?.client() ?? 'no turn is running');
          if (failure) {
            return method === 'exec'
              ? err(new ExecutionError('unknown', failure))
              : err(new FileError('unknown', failure, path ?? undefined));
          }
          if (method === 'exec') {
            context.abortSignal?.addEventListener('abort', () =>
              this.owner.log.push('exec-aborted'),
            );
          }
          await this.owner.options.hold?.(method, args);
          return value.apply(target, args);
        };
      },
    });
  }
}

export class LocalLease implements TurnLease {
  over = false;
  private acquired: Promise<string | null> | null = null;
  private stamped = false;

  constructor(
    private readonly thread: LocalThreadHands,
    private readonly options: TurnLeaseOptions,
  ) {}

  /** `null` once the sandbox is ready, else why there is none. */
  client(): Promise<string | null> {
    if (this.over) return Promise.resolve('the lease is over');
    this.acquired ??= this.acquire();
    return this.acquired;
  }

  private async acquire(): Promise<string | null> {
    const { owner } = this.thread;
    owner.log.push('acquire');
    const name = `local-${owner.acquisitions}`;
    const events = owner.options.events ?? [
      { kind: 'connecting' },
      { kind: 'ready', sandbox: name, source: 'fresh' },
    ];
    for (const event of events) {
      this.options.onEvent(event);
      if (event.kind === 'failed') return event.error;
    }
    this.thread.sandbox = name;
    this.stamped = true;
    this.thread.hooks.onSandbox(name);
    return null;
  }

  async warm(): Promise<void> {
    this.thread.owner.log.push('warm');
  }

  async finish(): Promise<TurnLeaseSummary> {
    if (!this.over) {
      this.over = true;
      this.thread.owner.log.push('finish');
    }
    return {
      source: this.acquired ? 'fresh' : 'none',
      sandbox: this.thread.sandbox,
      stamped: this.stamped,
    };
  }

  async abandon(): Promise<void> {
    if (this.over) return;
    this.over = true;
    this.thread.owner.log.push('abandon');
  }
}
