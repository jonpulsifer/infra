/**
 * A fake datastore backend.
 *
 * § Testing: **"Fake the far side, not our side."** This sits exactly at
 * `DatastoreAdapter` — it is the operator that is not there, never a stand-in
 * for anything in core.
 *
 * It does the two things a real operator cannot be asked to do on demand: it
 * **records** every call, so a test can assert what core asked for, and it
 * **replays a scripted state sequence**, so the mid-provision answer §11 calls
 * ordinary — `phase: 'WAITING'`, `connection: null` — is arrangeable without a
 * cluster that happens to be slow that day.
 */
import type {
  DatastoreAdapter,
  DatastoreEngine,
  DatastoreRef,
  DatastoreRequest,
  DatastoreState,
} from '../../../src/adapters/datastore/contract.ts';
import type { DeployTarget } from '../../../src/adapters/deploy/contract.ts';
import type { TargetAdapter } from '../../../src/config/manifest.schema.ts';

export interface FakeDatastoreAdapterOptions {
  adapter?: TargetAdapter;
  engines?: readonly DatastoreEngine[];
  /** When set, `provision` throws — the operator that refused the object. */
  provisionThrows?: string;
  /** When set, `destroy` throws — the far side refusing to tear down. */
  destroyThrows?: string;
  /** When set, `observe` throws — the Target that cannot be reached at all. */
  observeThrows?: string;
}

export class FakeDatastoreAdapter implements DatastoreAdapter {
  readonly adapter: TargetAdapter;
  readonly engines: readonly DatastoreEngine[];

  /** Every `provision`, in call order. */
  readonly provisioned: DatastoreRequest[] = [];
  /** Every `destroy`, including the repeats that prove idempotence. */
  readonly destroyed: DatastoreRef[] = [];
  /** Every `observe`, so a test can count the polls a pass actually made. */
  readonly observed: DatastoreRef[] = [];

  /**
   * The states each ref answers with, oldest first, the last one repeating.
   *
   * A queue rather than one value because the whole point of the loop is that
   * a datastore's answer changes between passes: WAITING with no connection,
   * then LIVE with one.
   */
  private readonly states = new Map<DatastoreRef, DatastoreState[]>();

  constructor(private readonly options: FakeDatastoreAdapterOptions = {}) {
    this.adapter = options.adapter ?? 'kubernetes';
    this.engines = options.engines ?? ['postgres', 'valkey'];
  }

  /**
   * Script what this ref reports, pass by pass.
   *
   * Arrangeable independently of `provision` for the same reason
   * `FakeDeployAdapter.place` is: "the adapter is the authority on what is
   * running, not core's memory" is only testable against a far side core never
   * saw created.
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
    // The last scripted state repeats: a test that cares about the first two
    // passes should not have to script the rest.
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  }

  async destroy(_target: DeployTarget, ref: DatastoreRef): Promise<void> {
    this.destroyed.push(ref);
    if (this.options.destroyThrows !== undefined) {
      throw new Error(this.options.destroyThrows);
    }
    this.states.delete(ref);
  }
}
