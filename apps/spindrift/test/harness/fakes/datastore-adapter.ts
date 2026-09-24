/** A `DatastoreAdapter` that records each call and replays scripted states. */
import type {
  DatastoreAdapter,
  DatastoreEngine,
  DatastoreRef,
  DatastoreRequest,
  DatastoreState,
} from '../../../src/adapters/datastore/contract.ts';
import type { DeployTarget } from '../../../src/adapters/deploy/contract.ts';
import type { TargetAdapter } from '../../../src/config/manifest.schema.ts';

/** Each `*Throws` makes its method record the call and then throw the message. */
export interface FakeDatastoreAdapterOptions {
  adapter?: TargetAdapter;
  engines?: readonly DatastoreEngine[];
  provisionThrows?: string;
  destroyThrows?: string;
  observeThrows?: string;
  /** What `describe` returns; absent returns `null`, as for no object. */
  describes?: unknown;
  describeThrows?: string;
  permitThrows?: string;
  /** `permit` returns `false`: the backend had nothing to write. */
  permitNoops?: boolean;
}

export class FakeDatastoreAdapter implements DatastoreAdapter {
  readonly adapter: TargetAdapter;
  readonly engines: readonly DatastoreEngine[];

  readonly provisioned: DatastoreRequest[] = [];
  readonly destroyed: DatastoreRef[] = [];
  readonly observed: DatastoreRef[] = [];
  readonly permits: { ref: DatastoreRef; namespaces: readonly string[] }[] = [];

  /** Each ref's states, oldest first; the last one repeats. */
  private readonly states = new Map<DatastoreRef, DatastoreState[]>();

  constructor(private readonly options: FakeDatastoreAdapterOptions = {}) {
    this.adapter = options.adapter ?? 'kubernetes';
    this.engines = options.engines ?? ['postgres', 'valkey'];
  }

  /**
   * Scripts a ref's states without a `provision` call, as for a far side core
   * never saw created.
   */
  script(ref: DatastoreRef, ...states: readonly DatastoreState[]): void {
    this.states.set(ref, [...states]);
  }

  async provision(
    _target: DeployTarget,
    request: DatastoreRequest,
  ): Promise<DatastoreRef> {
    this.provisioned.push(request);
    if (this.options.provisionThrows !== undefined) {
      throw new Error(this.options.provisionThrows);
    }
    const ref = `${request.engine}/fixture/${request.name}`;
    if (!this.states.has(ref)) {
      this.states.set(ref, [{ ref, phase: 'WAITING', connection: null }]);
    }
    return ref;
  }

  async observe(
    _target: DeployTarget,
    ref: DatastoreRef,
  ): Promise<DatastoreState | null> {
    this.observed.push(ref);
    if (this.options.observeThrows !== undefined) {
      throw new Error(this.options.observeThrows);
    }
    const queue = this.states.get(ref);
    if (queue === undefined || queue.length === 0) return null;
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  }

  readonly described: DatastoreRef[] = [];

  async describe(_target: DeployTarget, ref: DatastoreRef): Promise<unknown> {
    this.described.push(ref);
    if (this.options.describeThrows !== undefined) {
      throw new Error(this.options.describeThrows);
    }
    return this.options.describes ?? null;
  }

  async permit(
    _target: DeployTarget,
    ref: DatastoreRef,
    namespaces: readonly string[],
  ): Promise<boolean> {
    this.permits.push({ ref, namespaces: [...namespaces] });
    if (this.options.permitThrows !== undefined) {
      throw new Error(this.options.permitThrows);
    }
    return !this.options.permitNoops;
  }

  async destroy(_target: DeployTarget, ref: DatastoreRef): Promise<void> {
    this.destroyed.push(ref);
    if (this.options.destroyThrows !== undefined) {
      throw new Error(this.options.destroyThrows);
    }
    this.states.delete(ref);
  }
}
