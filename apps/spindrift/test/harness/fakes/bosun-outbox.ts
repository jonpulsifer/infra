/** A `BosunOutbox` whose `get` replays a scripted state per poll. */
import type {
  BosunOutbox,
  BosunOutboxState,
} from '../../../src/adapters/build/bosun.ts';

export interface FakeBosunOutboxOptions {
  /** What `get` reports, in poll order. The last entry repeats once exhausted. */
  readonly states?: readonly BosunOutboxState[];
}

const NEVER_CLAIMED: BosunOutboxState = { state: 'PENDING', result: null };

export class FakeBosunOutbox implements BosunOutbox {
  readonly enqueued: { id?: string; class: string; request: unknown }[] = [];
  readonly cancelled: string[] = [];

  private readonly states: readonly BosunOutboxState[];
  private reads = 0;
  /** The one request this fake holds; `enqueue` renames it when given an id. */
  private id: string;

  constructor(options: FakeBosunOutboxOptions = {}) {
    this.states = options.states?.length ? options.states : [NEVER_CLAIMED];
    this.id = 'fake-build-request';
  }

  async enqueue(input: {
    readonly id?: string;
    readonly class: string;
    readonly request: unknown;
  }): Promise<{ readonly id: string }> {
    this.enqueued.push(input);
    if (input.id !== undefined) this.id = input.id;
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
