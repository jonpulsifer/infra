/**
 * A fake bosun outbox (Task: bosun build route).
 *
 * § Testing: "Fake the far side, not our side." `BosunOutbox` is the seam
 * `src/adapters/build/bosun.ts` polls through; this is the pool that never
 * answers on its own — a test scripts exactly what `get` reports on each
 * poll, the same way `FakeBuildAdapter` scripts a route's result.
 */
import type {
  BosunOutbox,
  BosunOutboxState,
} from '../../../src/adapters/build/bosun.ts';

export interface FakeBosunOutboxOptions {
  /**
   * What `get` reports, in poll order, for the one request this fake ever
   * hands out. The last entry repeats once the script is exhausted — a poll
   * loop that ran one iteration longer than expected should not fall off the
   * end of the script into `undefined`.
   */
  readonly states?: readonly BosunOutboxState[];
}

const NEVER_CLAIMED: BosunOutboxState = { state: 'PENDING', result: null };

export class FakeBosunOutbox implements BosunOutbox {
  /** Every `enqueue`, in call order. */
  readonly enqueued: { class: string; request: unknown }[] = [];
  /** Every id `cancel` was called with, in call order. */
  readonly cancelled: string[] = [];

  private readonly states: readonly BosunOutboxState[];
  private reads = 0;
  private readonly id: string;

  constructor(options: FakeBosunOutboxOptions = {}) {
    this.states = options.states?.length ? options.states : [NEVER_CLAIMED];
    this.id = 'fake-build-request';
  }

  async enqueue(input: {
    readonly class: string;
    readonly request: unknown;
  }): Promise<{ readonly id: string }> {
    this.enqueued.push(input);
    return { id: this.id };
  }

  async get(id: string): Promise<BosunOutboxState | null> {
    if (id !== this.id) return null;
    const index = Math.min(this.reads, this.states.length - 1);
    this.reads += 1;
    return this.states[index] ?? null;
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
  }
}
