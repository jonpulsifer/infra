/**
 * The datastore adapter contract. `provision` is one write, then core polls
 * `observe` the way it polls a deploy. Only `managed` Datastores reach an
 * adapter: an `external` one is nothing but its authored connection reference.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type {
  DeployPhase,
  DeployTarget,
  FailureReason,
} from '../deploy/contract.ts';

export type DatastoreEngine = 'postgres' | 'valkey';

/** What `provision` created. Opaque to core, which stores and returns it. */
export type DatastoreRef = string;

export interface DatastoreRequest {
  /** A Datastore outlives detachment: its backend object never names an App. */
  readonly name: string;
  readonly engine: DatastoreEngine;
  readonly storageGiB: number;
}

/**
 * `secret://<container>/<item>` names where the credential lives; `redis://`
 * is for an engine without auth. Not `valkey://`, which Redis clients reject.
 */
export type DatastoreConnection = string;

export interface DatastoreState {
  readonly ref: DatastoreRef;
  readonly phase: DeployPhase;
  readonly reason?: FailureReason;
  readonly detail?: string;
  /** `null` mid-provision, before the credential exists; not a failure. */
  readonly connection: DatastoreConnection | null;
}

export interface DatastoreAdapter {
  readonly adapter: TargetAdapter;

  /**
   * Engines this code can write. A Target's `postgres`/`valkey` capability says
   * whether the cluster serves the operator; placement needs both.
   */
  readonly engines: readonly DatastoreEngine[];

  /**
   * Idempotent: an existing datastore returns the same ref. Errors throw; they
   * are never reported as a failed state.
   */
  provision(
    target: DeployTarget,
    request: DatastoreRequest,
  ): Promise<DatastoreRef>;

  /** The current state, or `null` when nothing is there. */
  observe(
    target: DeployTarget,
    ref: DatastoreRef,
  ): Promise<DatastoreState | null>;

  /** Idempotent: destroying what is already gone succeeds. */
  destroy(target: DeployTarget, ref: DatastoreRef): Promise<void>;

  /**
   * Replaces the admitted network locations; empty admits nobody. Re-asserted
   * on a schedule, so idempotent; `false` means no boundary was written.
   */
  permit?(
    target: DeployTarget,
    ref: DatastoreRef,
    namespaces: readonly string[],
  ): Promise<boolean>;

  /**
   * The backend's own object, verbatim, for a person diagnosing it. Absent, or
   * `null` when the object is gone, both render as nothing to show.
   */
  describe?(target: DeployTarget, ref: DatastoreRef): Promise<unknown>;
}
