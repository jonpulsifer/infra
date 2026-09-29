/**
 * The lease: a turn's sandbox, acquired on its first tool call and given back
 * when the turn ends, and the slots that cap how many sandboxes are leased.
 */
import type { Clock, Handle } from './clock.ts';
import {
  type Credentials,
  STAMP_TIMEOUT_MS,
  type TurnCredentials,
} from './credentials.ts';
import type { HandsClient } from './hands.ts';
import {
  HandsEnv,
  HandsImageTooOld,
  type HandsLink,
  type HandsTarget,
  type LeaseAccess,
  LeaseFailure,
  SandboxGone,
} from './hands-env.ts';
import {
  ABANDON_BUDGET_MS,
  type HandsDropReason,
  type HandsInstruments,
  type LeaseEvent,
  type OnMintStep,
  type SandboxSource,
  type ThreadHands,
  type ThreadHandsHooks,
  type TurnLease,
  type TurnLeaseOptions,
  type TurnLeaseSummary,
  type TurnSandboxSource,
} from './lease.ts';
import { type Log, plain } from './log.ts';
import type { ThreadRef } from './surface.ts';

/** How long a holder sits idle before a waiting thread may take its sandbox. */
export const PREEMPT_IDLE_MS = 300_000;
/** A turn gets a second sandbox after losing one, and no third. */
export const MAX_ACQUIRES_PER_TURN = 2;

export interface SandboxHandle extends HandsTarget {
  readonly podUid: string | null;
  readonly source: SandboxSource;
}

interface Holder {
  busy: number;
  lastUsed: number;
  evicting: boolean;
}

interface Waiter {
  readonly key: string;
  ahead: number;
  resolve(): void;
  reject(reason: unknown): void;
  onWaiting?(ahead: number): void;
  detach(): void;
}

export interface SlotsOptions {
  readonly capacity: number;
  readonly clock: Clock;
  readonly log: Log;
  readonly metrics?: HandsInstruments;
  /** Takes an idle holder's sandbox away; true once it no longer counts. */
  evict(key: string): Promise<boolean>;
}

/**
 * The cap on leased sandboxes, `MATE_MAX_SANDBOXES`. A thread holds a slot
 * from its first acquisition until its sandbox is gone. A holder is busy
 * while a turn or a mint uses it; an idle one can be preempted by a waiting
 * thread once it has sat idle for `PREEMPT_IDLE_MS`.
 */
export class SandboxSlots {
  private readonly holders = new Map<string, Holder>();
  private readonly waiters: Waiter[] = [];
  private timer: Handle | null = null;
  private eviction: Promise<void> | null = null;

  constructor(private readonly opts: SlotsOptions) {
    opts.metrics?.sandboxesLive(0);
    opts.metrics?.sandboxWaiters(0);
  }

  holds(key: string): boolean {
    return this.holders.has(key);
  }

  /**
   * Resolves once `key` holds a slot: at once when it already does or one is
   * free. Otherwise it queues, first come first served, and reports its place.
   * A slot being taken from `key` is waited out first, since its sandbox may
   * be going.
   */
  take(
    key: string,
    options: { signal?: AbortSignal; onWaiting?(ahead: number): void } = {},
  ): Promise<void> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const held = this.holders.get(key);
    if (held?.evicting && this.eviction) {
      return settledOrAborted(this.eviction, signal).then(() =>
        this.take(key, options),
      );
    }
    if (held) return Promise.resolve();
    if (this.waiters.length === 0 && this.free()) {
      this.hold(key);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(signal?.reason);
        this.pump();
      };
      const waiter: Waiter = {
        key,
        ahead: -1,
        resolve,
        reject,
        onWaiting: options.onWaiting,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /** A sandbox already standing counts, whatever the cap: at boot, or found in place. */
  register(key: string): void {
    if (this.holders.has(key)) return;
    this.hold(key);
  }

  /** Busy until the returned function runs; `null` when `key` holds no slot. */
  use(key: string): (() => void) | null {
    const holder = this.holders.get(key);
    if (!holder) return null;
    holder.busy += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.holders.get(key) !== holder) return;
      holder.busy -= 1;
      if (holder.busy === 0) holder.lastUsed = this.opts.clock.now();
      this.pump();
    };
  }

  /** The slot's sandbox is gone. */
  release(key: string): void {
    if (!this.holders.delete(key)) return;
    this.pump();
  }

  private free(): boolean {
    return this.holders.size < this.opts.capacity;
  }

  private hold(key: string): void {
    this.holders.set(key, {
      busy: 0,
      lastUsed: this.opts.clock.now(),
      evicting: false,
    });
    this.report();
  }

  private pump(): void {
    if (this.timer) this.opts.clock.cancel(this.timer);
    this.timer = null;
    while (this.waiters.length > 0) {
      const head = this.waiters[0] as Waiter;
      if (!this.holders.has(head.key)) {
        if (!this.free()) {
          if (!this.eviction) this.preempt();
          break;
        }
        this.hold(head.key);
      }
      this.waiters.shift();
      head.detach();
      head.resolve();
    }
    this.report();
  }

  /** Evicts the least recently used idle holder, or wakes when one qualifies. */
  private preempt(): void {
    const now = this.opts.clock.now();
    let victim: [string, Holder] | null = null;
    let soonest = Number.POSITIVE_INFINITY;
    for (const entry of this.holders) {
      const [, holder] = entry;
      if (holder.busy > 0 || holder.evicting) continue;
      soonest = Math.min(soonest, holder.lastUsed + PREEMPT_IDLE_MS);
      if (now - holder.lastUsed < PREEMPT_IDLE_MS) continue;
      if (!victim || holder.lastUsed < victim[1].lastUsed) victim = entry;
    }
    if (!victim) {
      // Every holder is busy: the first to go idle wakes the queue.
      if (Number.isFinite(soonest)) {
        this.timer = this.opts.clock.after(soonest - now, () => {
          this.timer = null;
          this.pump();
        });
      }
      return;
    }
    const [key, holder] = victim;
    holder.evicting = true;
    this.eviction = this.opts
      .evict(key)
      .catch((error: unknown) => {
        this.opts.log.warn('could not preempt an idle sandbox', {
          thread: key,
          error: plain(error),
        });
        return false;
      })
      .then((evicted) => {
        this.eviction = null;
        holder.evicting = false;
        if (evicted) {
          if (this.holders.get(key) === holder) this.holders.delete(key);
        } else {
          // Not again until it has sat idle for another window.
          holder.lastUsed = this.opts.clock.now();
        }
        this.pump();
      });
  }

  private report(): void {
    this.waiters.forEach((waiter, ahead) => {
      if (waiter.ahead === ahead) return;
      waiter.ahead = ahead;
      try {
        waiter.onWaiting?.(ahead);
      } catch {}
    });
    this.opts.metrics?.sandboxesLive(this.holders.size);
    this.opts.metrics?.sandboxWaiters(this.waiters.length);
  }
}

/** What a lease asks of the cluster; `KubeHands` provides it. */
export interface LeaseDeps {
  readonly log: Log;
  readonly clock: Clock;
  readonly metrics?: HandsInstruments;
  readonly slots: SandboxSlots;
  readonly credentials: Credentials;
  /** Where the daemon runs and what `HandsEnv` resolves paths against. */
  readonly workspace: string;
  readonly home: string;
  /** Finds, adopts or mints the thread's sandbox, Ready. */
  acquire(ref: ThreadRef, onStep: OnMintStep): Promise<SandboxHandle>;
  /** The thread's sandbox when one stands Ready; never mints. */
  find(ref: ThreadRef): Promise<SandboxHandle | null>;
  /** A link to `handle`'s pod; its open fails `SandboxGone` once that pod is not there. */
  link(handle: SandboxHandle): HandsLink;
  slide(name: string): Promise<void>;
  /** A sandbox that died or that mate cannot speak to: out of every thread's reach. Never throws. */
  lose(name: string): Promise<void>;
  /** A sandbox that became Ready for a thread already put away. Never throws. */
  discard(name: string): Promise<void>;
}

/**
 * A thread's hands for its life in this process: the env pi's tools call, the
 * sandbox the thread holds, and the acquisition, which outlives a turn that
 * stopped waiting for it.
 */
export class ThreadHandsImpl implements ThreadHands {
  readonly env: HandsEnv;
  /** The sandbox the thread holds, by name, until it is lost or released. */
  holding: string | null;
  released = false;
  private acquiring: Promise<SandboxHandle> | null = null;
  private lease: TurnLeaseImpl | null = null;

  constructor(
    readonly ref: ThreadRef,
    readonly key: string,
    public hooks: ThreadHandsHooks,
    private readonly deps: LeaseDeps,
    holding: string | null = null,
  ) {
    this.holding = holding;
    this.env = new HandsEnv({
      cwd: deps.workspace,
      home: deps.home,
      clock: deps.clock,
      metrics: deps.metrics,
      lease: () => this.lease,
    });
  }

  get openLease(): TurnLeaseImpl | null {
    return this.lease;
  }

  get busy(): boolean {
    return this.acquiring !== null;
  }

  beginTurn(options: TurnLeaseOptions): TurnLease {
    if (this.lease) {
      throw new Error(`a turn is already running in thread ${this.key}`);
    }
    const lease = new TurnLeaseImpl(this, options, this.deps);
    this.lease = lease;
    return lease;
  }

  /** The lease's terminal work is done; the next turn may begin. */
  ended(lease: TurnLeaseImpl): void {
    if (this.lease === lease) this.lease = null;
  }

  acquire(onStep: OnMintStep): Promise<SandboxHandle> {
    this.acquiring ??= this.run(onStep).finally(() => {
      this.acquiring = null;
    });
    return this.acquiring;
  }

  /** A sandbox found standing, as before a resume. */
  found(handle: SandboxHandle): void {
    this.holding = handle.sandbox;
    this.tell((hooks) => hooks.onSandbox(handle.sandbox));
  }

  /** The sandbox died or was taken away; its work went with it. */
  gone(name: string): void {
    if (this.holding === name) this.holding = null;
  }

  tell(say: (hooks: ThreadHandsHooks) => void): void {
    try {
      say(this.hooks);
    } catch (error) {
      this.deps.log.warn('a thread hook threw', {
        thread: this.key,
        error: plain(error),
      });
    }
  }

  private async run(onStep: OnMintStep): Promise<SandboxHandle> {
    const done = this.deps.slots.use(this.key);
    try {
      const handle = await this.deps.acquire(this.ref, onStep);
      if (this.released) {
        await this.deps.discard(handle.sandbox);
        throw new Error('the thread was put away while its sandbox started');
      }
      this.found(handle);
      return handle;
    } catch (error) {
      if (!this.holding) this.deps.slots.release(this.key);
      throw error;
    } finally {
      done?.();
    }
  }
}

type State =
  | 'idle'
  | 'acquiring'
  | 'connecting'
  | 'stamping'
  | 'ready'
  | 'failed';

const TURN_OVER = 'the turn is over';

/**
 * One turn's hold on its thread's sandbox. The first call acquires, connects
 * and stamps, once, for every call that arrives meanwhile; each caller can
 * stop waiting on its own signal without cancelling the acquisition.
 */
export class TurnLeaseImpl implements TurnLease, LeaseAccess {
  private state: State = 'idle';
  private closed = false;
  private pending: Promise<HandsClient | LeaseFailure> | null = null;
  private target: SandboxHandle | null = null;
  private link: HandsLink | null = null;
  private stampedPod: string | null = null;
  private stamping: Promise<void> | null = null;
  private failure: string | null = null;
  private acquisitions = 0;
  private announced = false;
  private source: SandboxSource | null = null;
  private minting: { source: SandboxSource; mintMs: number } | null = null;
  private terminal: Promise<TurnLeaseSummary> | null = null;
  private busy: (() => void) | null;
  private readonly creds: TurnCredentials;
  /** Aborted by `finish` or `abandon`: the turn no longer waits for a slot. */
  private readonly over = new AbortController();

  constructor(
    private readonly thread: ThreadHandsImpl,
    private readonly options: TurnLeaseOptions,
    private readonly deps: LeaseDeps,
  ) {
    this.busy = deps.slots.use(thread.key);
    this.creds = deps.credentials.turn();
  }

  client(signal: AbortSignal | undefined): Promise<HandsClient | LeaseFailure> {
    if (this.closed) return Promise.resolve(new LeaseFailure(TURN_OVER));
    if (this.failure) return Promise.resolve(new LeaseFailure(this.failure));
    const live = this.state === 'ready' ? this.link?.current() : null;
    if (live) return Promise.resolve(live);
    const signals = [signal, this.options.signal];
    if (signals.some((s) => s?.aborted)) {
      return Promise.resolve(new LeaseFailure('aborted', true));
    }
    this.pending ??= this.advance().finally(() => {
      this.pending = null;
    });
    return raceAborts(this.pending, signals);
  }

  current(): HandsClient | null {
    return this.link?.current() ?? null;
  }

  drop(client: HandsClient, reason: HandsDropReason): void {
    this.link?.drop(client, reason);
  }

  async warm(): Promise<void> {
    if (this.closed || this.target) return;
    const { deps, thread } = this;
    try {
      const found = await deps.find(thread.ref);
      if (!found || this.closed || this.target) return;
      deps.slots.register(thread.key);
      this.markBusy();
      thread.found(found);
      this.target = found;
      this.source = found.source;
      this.link = deps.link(found);
      await this.link.get();
    } catch (error) {
      // The turn ended first, and sealed the link.
      if (this.closed) return;
      deps.log.warn('could not reconnect to the sandbox before a resume', {
        thread: thread.key,
        error: plain(error),
      });
      const link = this.link;
      this.target = null;
      this.link = null;
      await link?.close();
    }
  }

  finish(): Promise<TurnLeaseSummary> {
    this.close();
    this.terminal ??= this.wrapUp();
    return this.terminal;
  }

  abandon(): Promise<void> {
    this.close();
    this.terminal ??= this.giveUp();
    return within(
      this.deps.clock,
      this.terminal.then(() => {}),
      ABANDON_BUDGET_MS,
    );
  }

  /**
   * Nothing new starts: no slot wait, connect, mint or stamp. A connect
   * already under way closes what it opens, and a token minted later is
   * revoked as it lands.
   */
  private close(): void {
    this.closed = true;
    this.link?.seal();
    this.creds.seal();
    this.over.abort(new Error(TURN_OVER));
  }

  /** The slot `thread` holds now, whichever it held when the turn began. */
  private markBusy(): void {
    const was = this.busy;
    this.busy = this.deps.slots.use(this.thread.key);
    was?.();
  }

  private async advance(): Promise<HandsClient | LeaseFailure> {
    try {
      if (!this.target) {
        const failed = await this.acquire();
        if (failed) return failed;
      }
      const target = this.target as SandboxHandle;
      const link = this.link as HandsLink;
      if (!this.announced) this.emit({ kind: 'connecting' });
      this.state = 'connecting';
      let client: HandsClient;
      try {
        client = await link.get();
      } catch (error) {
        return this.unreachable(error);
      }
      if (this.minting) {
        this.deps.metrics?.minted('ok', this.minting);
        this.minting = null;
      }
      if (this.closed) return new LeaseFailure(TURN_OVER);
      await this.stamp(target, client);
      if (this.closed) return new LeaseFailure(TURN_OVER);
      this.state = 'ready';
      if (!this.announced) {
        this.announced = true;
        this.source = target.source;
        this.emit({
          kind: 'ready',
          sandbox: target.sandbox,
          source: target.source,
        });
      }
      return client;
    } catch (error) {
      this.deps.log.error('the lease failed unexpectedly', {
        thread: this.thread.key,
        error: plain(error),
      });
      return new LeaseFailure(plain(error));
    }
  }

  /** `null` once the turn has a Ready sandbox and a link to it. */
  private async acquire(): Promise<LeaseFailure | null> {
    const { deps, thread } = this;
    if (this.acquisitions >= MAX_ACQUIRES_PER_TURN) {
      return this.fail(
        'the sandbox was lost twice this turn; the next turn starts a fresh one',
      );
    }
    this.acquisitions += 1;
    this.state = 'acquiring';
    try {
      await deps.slots.take(thread.key, {
        signal: AbortSignal.any([this.options.signal, this.over.signal]),
        onWaiting: (ahead) => this.emit({ kind: 'waiting', ahead }),
      });
    } catch {
      return new LeaseFailure(TURN_OVER);
    }
    if (this.closed) return new LeaseFailure(TURN_OVER);
    this.markBusy();
    const started = deps.clock.now();
    let handle: SandboxHandle;
    try {
      handle = await thread.acquire((step) =>
        this.emit({ kind: 'step', step }),
      );
    } catch (error) {
      deps.metrics?.minted('mint-failed');
      return this.fail(`could not start a sandbox: ${plain(error)}`);
    }
    const minted = {
      source: handle.source,
      mintMs: deps.clock.now() - started,
    };
    if (this.closed) {
      // Stopped while it started; the thread keeps it, unconnected.
      deps.metrics?.minted('ok', minted);
      return new LeaseFailure(TURN_OVER);
    }
    this.target = handle;
    this.link = deps.link(handle);
    this.announced = false;
    this.minting = minted;
    return null;
  }

  private unreachable(error: unknown): LeaseFailure {
    if (error instanceof SandboxGone || error instanceof HandsImageTooOld) {
      return this.lose(error);
    }
    if (this.closed) return new LeaseFailure(TURN_OVER);
    const message = `could not reach the sandbox: ${plain(error)}`;
    if (this.announced) return new LeaseFailure(message);
    if (this.minting) {
      this.deps.metrics?.minted('connect-failed', this.minting);
      this.minting = null;
    }
    return this.fail(message);
  }

  /** The sandbox died, or runs no daemon mate speaks to: the next call starts another. */
  private lose(error: unknown): LeaseFailure {
    const { deps, thread } = this;
    const target = this.target as SandboxHandle;
    if (this.minting) {
      deps.metrics?.minted('connect-failed', this.minting);
      this.minting = null;
    }
    const link = this.link;
    this.target = null;
    this.link = null;
    this.stampedPod = null;
    this.announced = false;
    this.state = 'idle';
    void link?.close();
    thread.gone(target.sandbox);
    void deps.lose(target.sandbox);
    deps.log.warn('the sandbox is gone', {
      thread: thread.key,
      sandbox: target.sandbox,
      error: plain(error),
    });
    thread.tell((hooks) => hooks.onSandboxGone('lost'));
    this.emit({ kind: 'lost', sandbox: target.sandbox, error: plain(error) });
    return new LeaseFailure(
      `the sandbox ${target.sandbox} is gone, and every file in it; the next command starts a fresh sandbox`,
    );
  }

  private fail(message: string): LeaseFailure {
    this.failure = message;
    this.state = 'failed';
    this.emit({ kind: 'failed', error: message });
    return new LeaseFailure(message);
  }

  /** Once per pod per turn, before any call on it is admitted. */
  private async stamp(target: SandboxHandle, client: HandsClient) {
    const pod = `${target.sandbox}/${target.pod}`;
    if (this.stampedPod === pod) return;
    this.state = 'stamping';
    this.stamping = this.creds.stamp(target, client);
    try {
      await this.stamping;
    } finally {
      this.stamping = null;
    }
    this.stampedPod = pod;
  }

  private async wrapUp(): Promise<TurnLeaseSummary> {
    const { deps } = this;
    if (this.stamping) {
      await within(deps.clock, this.stamping, STAMP_TIMEOUT_MS);
    }
    const { target, link } = this;
    if (target) await this.creds.retire(target, link?.current() ?? null);
    await this.creds.revoke();
    await link?.close();
    if (target) {
      await deps.slide(target.sandbox).catch((error: unknown) =>
        deps.log.warn('shutdownTime slide failed', {
          sandbox: target.sandbox,
          error: plain(error),
        }),
      );
    }
    return this.settle();
  }

  private async giveUp(): Promise<TurnLeaseSummary> {
    const { deps } = this;
    // First, within the budget; a mint still running revokes its own.
    await this.creds.revoke();
    if (this.stamping) {
      await within(deps.clock, this.stamping, ABANDON_BUDGET_MS);
    }
    const { target, link } = this;
    if (target) await this.creds.retire(target, link?.current() ?? null);
    await link?.close();
    return this.settle();
  }

  private settle(): TurnLeaseSummary {
    const { deps, thread } = this;
    const summary: TurnLeaseSummary = {
      source: this.summarySource(),
      sandbox: this.target?.sandbox ?? null,
      stamped: this.creds.stamped,
    };
    deps.metrics?.turnSandbox(summary.source);
    this.busy?.();
    this.busy = null;
    // A slot with no sandbox behind it goes to whoever waits for one.
    if (!thread.holding && !thread.busy) deps.slots.release(thread.key);
    thread.ended(this);
    return summary;
  }

  private summarySource(): TurnSandboxSource {
    if (this.announced && this.source) return this.source;
    return this.acquisitions > 0 ? 'failed' : 'none';
  }

  private emit(event: LeaseEvent): void {
    if (this.closed) return;
    try {
      this.options.onEvent(event);
    } catch (error) {
      this.deps.log.warn('a lease listener threw', {
        thread: this.thread.key,
        error: plain(error),
      });
    }
  }
}

function raceAborts<T>(
  promise: Promise<T>,
  signals: (AbortSignal | undefined)[],
): Promise<T | LeaseFailure> {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return promise;
  return new Promise((resolve) => {
    const onAbort = () => {
      cleanup();
      resolve(new LeaseFailure('aborted', true));
    };
    const cleanup = () => {
      for (const signal of live) signal.removeEventListener('abort', onAbort);
    };
    for (const signal of live) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        resolve(new LeaseFailure(plain(error)));
      },
    );
  });
}

/** Resolves once `promise` settles either way; rejects once `signal` aborts. */
function settledOrAborted(
  promise: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    promise.then(done, done);
  });
}

/** Waits for `promise`, but no longer than `ms`. */
async function within(
  clock: Clock,
  promise: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: Handle | null = null;
  const expired = new Promise<void>((resolve) => {
    timer = clock.after(ms, resolve);
  });
  try {
    await Promise.race([
      promise.then(
        () => {},
        () => {},
      ),
      expired,
    ]);
  } finally {
    if (timer) clock.cancel(timer);
  }
}
