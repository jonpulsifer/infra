/**
 * The datastore reconcile loop (§11).
 *
 * `provision` is one write and then silence: the operator creates a
 * StatefulSet, waits for a PVC to bind, runs a bootstrap job, and only then
 * generates the credential. §11's contract puts no stream on that seam — "a
 * Datastore is provisioned once and then outlives every App attached to it" —
 * so core polls `observe` exactly the way it polls a deploy's, and this is the
 * poller.
 *
 * Two facts move from the far side into the row, and they arrive at different
 * times:
 *
 * - **`phase` and `detail`**, every pass, because that is what a screen shows
 *   and what a stuck datastore is diagnosed from.
 * - **`connection_ref`, only once there is one.** `DatastoreState.connection`
 *   is `null` for the whole of a healthy provision — the contract says so in
 *   its own words: "a caller that treats `null` as failure would fail every
 *   healthy provision" — so a pass that wrote it unconditionally would clear a
 *   reference that a Deploy has already pinned. It is written when non-null
 *   and never cleared.
 *
 * `state === null` is the other answer: the object is not there. For a row
 * this loop only looks at *because* core recorded a ref, that is a datastore
 * something deleted out of band, and FAILED with the Target named is the
 * honest verdict — silently re-provisioning would be core deciding that a
 * deliberate `kubectl delete` was a mistake.
 */
import { and, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { DatastoreState } from '../adapters/datastore/contract.ts';
import type { DeployPhase } from '../adapters/deploy/contract.ts';
import type { AdapterRegistry } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { datastores, targets, vessels } from '../db/schema.ts';
import { deployTargetOf, targetLabel } from '../domain/target.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';

/** What the loop needs. A structural subset of `ReconcilerContext`. */
export interface DatastoreLoopContext {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly clock: { now(): Date };
}

/** What one pass did, per Datastore it looked at. */
export interface DatastoreReport {
  readonly datastoreId: string;
  readonly phase: DeployPhase;
  /** Whether this pass was the one that learned where the credential lives. */
  readonly connected: boolean;
}

/** Poll every unsettled managed Datastore once. */
export async function runDatastorePass(
  context: DatastoreLoopContext,
): Promise<readonly DatastoreReport[]> {
  // Unsettled only: a row that is LIVE *and* has a connection has nothing left
  // for a poll to learn, and this loop's whole cost is one adapter round trip
  // per row it selects.
  //
  // ponytail: unsettled rows only — no drift re-observe of a LIVE datastore.
  // Add a slow second cadence if a dropped Cluster object needs noticing.
  // The Datastore anchors to its vessel; the surface an `observe` addresses
  // is derived from the vessel's kind. The join condition is the SQL spelling
  // of `DATASTORE_SURFACE_BY_VESSEL_KIND`'s two rows — one batched query
  // rather than the point lookup per row, because a pass over many datastores
  // must not be many queries.
  const rows = await context.db
    .select({
      id: datastores.id,
      ref: datastores.ref,
      connectionRef: datastores.connectionRef,
      target: targets,
      vessel: vessels,
    })
    .from(datastores)
    .innerJoin(vessels, eq(datastores.vesselId, vessels.id))
    .innerJoin(
      targets,
      and(
        eq(targets.vesselId, vessels.id),
        or(
          and(eq(vessels.kind, 'cluster'), eq(targets.adapter, 'kubernetes')),
          and(eq(vessels.kind, 'gcp-project'), eq(targets.adapter, 'cloudrun')),
        ),
      ),
    )
    .where(
      and(
        eq(datastores.provenance, 'managed'),
        isNotNull(datastores.ref),
        or(ne(datastores.phase, 'LIVE'), isNull(datastores.connectionRef)),
      ),
    );

  const reports: DatastoreReport[] = [];
  for (const row of rows) {
    const connection = row.target.connection;
    const location = row.vessel.location;
    const adapter = context.adapters.datastore?.(row.target.adapter) ?? null;
    // A Target nothing can address and an installation with no adapter for it
    // are both facts about *this process*, not about the datastore. Writing
    // FAILED for either would blame the database for a deployment's own gap.
    if (
      connection === null ||
      location === null ||
      adapter === null ||
      row.ref === null
    ) {
      continue;
    }

    let state: DatastoreState | null;
    try {
      state = await adapter.observe(
        deployTargetOf(
          { adapter: row.target.adapter, connection },
          { ...row.vessel, location },
        ),
        row.ref,
      );
    } catch {
      // A Target that cannot be reached has not lost its database. The same
      // call `deploy-loop.ts` makes and the same reason: an uplink blip is not
      // a verdict, and the next pass asks again.
      continue;
    }

    const now = context.clock.now();
    if (state === null) {
      await context.db
        .update(datastores)
        .set({
          phase: 'FAILED',
          detail: `nothing answers to this Datastore on ${targetLabel({
            vessel: row.vessel.name,
            adapter: row.target.adapter,
          })}`,
          updatedAt: now,
        })
        .where(eq(datastores.id, row.id));
      reports.push({
        datastoreId: row.id,
        phase: 'FAILED',
        connected: false,
      });
      continue;
    }

    const connected = state.connection !== null && row.connectionRef === null;
    await context.db
      .update(datastores)
      .set({
        phase: state.phase,
        detail: state.detail ?? null,
        // Written only when the far side has one. Absent from the `set` object
        // otherwise, rather than set to what is already there, so a row whose
        // reference a Deploy has pinned cannot be cleared by a later pass that
        // caught the operator mid-rotation.
        ...(state.connection === null
          ? {}
          : { connectionRef: state.connection }),
        updatedAt: now,
      })
      .where(eq(datastores.id, row.id));

    reports.push({ datastoreId: row.id, phase: state.phase, connected });
  }
  return reports;
}

/** How often to poll, and how to stop. */
export interface DatastoreLoopOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (reports: readonly DatastoreReport[]) => void;
}

/**
 * Fast, because somebody is watching.
 *
 * A datastore is provisioned by a developer who is waiting to attach it, and
 * the whole of a pass is one adapter call per *unsettled* row — which is zero
 * on an installation whose databases have all come up.
 */
export const DEFAULT_DATASTORE_INTERVAL_MS = 15_000;

/** Run until aborted. */
export async function runDatastoreLoop(
  context: DatastoreLoopContext,
  options: DatastoreLoopOptions = {},
): Promise<void> {
  const interval = options.intervalMs ?? DEFAULT_DATASTORE_INTERVAL_MS;
  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    const reports = await runDatastorePass(context);
    reconcilerLoopDuration.record((Date.now() - startedAt) / 1000, {
      loop: 'datastore',
    });
    options.onPass?.(reports);
    if (options.signal?.aborted) return;
    await sleep(interval, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
