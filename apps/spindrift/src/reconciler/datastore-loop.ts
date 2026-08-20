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
 *
 * **One fact moves the other way, and this loop is where it does** (§127): the
 * network exception admitting the attached App's namespace to the Datastore.
 * It is written here rather than by `attachDatastore` and `detachDatastore`,
 * because those two are not the only things that change the answer —
 * `datastores.app_id` is `ON DELETE SET NULL`, so deleting an App detaches
 * every Datastore it held with no command in the path at all. A revoke hung
 * off the commands would silently never fire and would leave a hole aimed at a
 * namespace nothing ever deletes. A loop reading the row converges however the
 * column changed, and retries the write a command could only have dropped.
 */
import { and, eq, isNotNull, or } from 'drizzle-orm';
import type { DatastoreState } from '../adapters/datastore/contract.ts';
import type { DeployPhase } from '../adapters/deploy/contract.ts';
import type { AdapterRegistry } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { apps, datastores, targets, vessels } from '../db/schema.ts';
import {
  appNamespaceFor,
  deployTargetOf,
  targetLabel,
} from '../domain/target.ts';
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
  /** Whether this pass was the one that moved the network exception. */
  readonly permitted: boolean;
}

/** Converge every managed Datastore once. */
export async function runDatastorePass(
  context: DatastoreLoopContext,
): Promise<readonly DatastoreReport[]> {
  // Every managed Datastore with a handle, settled or not — because the
  // attachment of a *settled* one is precisely what changes. A row that is
  // LIVE and connected has nothing left for a poll to learn, so the unsettled
  // test that used to be in this `where` is still made, one `if` further down,
  // and still decides whether a round trip is spent observing. What it no
  // longer decides is whether the row is looked at at all.
  //
  // ponytail: a full scan of the managed rows per pass, and no re-observe of a
  // settled one. Index `(provenance, ref)` if a fleet ever holds hundreds.
  //
  // The Datastore anchors to its vessel; the surface an `observe` addresses
  // is derived from the vessel's kind. The join condition is the SQL spelling
  // of `DATASTORE_SURFACE_BY_VESSEL_KIND`'s two rows — one batched query
  // rather than the point lookup per row, because a pass over many datastores
  // must not be many queries.
  //
  // The App is joined `left` because detached is the ordinary state of a
  // Datastore that outlived its App, and it is the state whose exception has
  // to be taken away.
  const rows = await context.db
    .select({
      id: datastores.id,
      ref: datastores.ref,
      phase: datastores.phase,
      connectionRef: datastores.connectionRef,
      permittedNamespace: datastores.permittedNamespace,
      appName: apps.name,
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
    .leftJoin(apps, eq(datastores.appId, apps.id))
    .where(
      and(eq(datastores.provenance, 'managed'), isNotNull(datastores.ref)),
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
    const target = deployTargetOf(
      { adapter: row.target.adapter, connection },
      { ...row.vessel, location },
    );

    // The network exception, before the poll, because the poll is the half
    // that gives up on a row: a datastore whose object was deleted out of band
    // is FAILED and skipped, and the App attached to it must still stop being
    // admitted to whatever is left.
    //
    // Where the attached App sits is a Kubernetes fact and `appNamespaceFor`
    // is where it lives — the same function the delivery path renders an App's
    // namespace from, so the name here and the namespace the release lands in
    // cannot drift apart. A Target of any other adapter kind has no namespace
    // for an App to be in, and its datastore adapter has no `permit` either.
    const desired =
      row.appName === null || connection.adapter !== 'kubernetes'
        ? null
        : appNamespaceFor(connection, row.appName);
    let permitted = false;
    if (adapter.permit !== undefined && desired !== row.permittedNamespace) {
      try {
        await adapter.permit(
          target,
          row.ref,
          desired === null ? [] : [desired],
        );
      } catch {
        // The same answer the poll below gives an unreachable Target: not a
        // verdict, and the next pass asks again. The column is left saying
        // what the cluster was last actually told, which is what makes the
        // retry happen at all.
        continue;
      }
      await context.db
        .update(datastores)
        .set({ permittedNamespace: desired })
        .where(eq(datastores.id, row.id));
      permitted = true;
    }

    // Settled: LIVE *and* holding a connection reference has nothing left for
    // a poll to learn, and this loop's per-row cost is the round trip.
    if (row.phase === 'LIVE' && row.connectionRef !== null) {
      if (permitted) {
        reports.push({
          datastoreId: row.id,
          phase: row.phase,
          connected: false,
          permitted,
        });
      }
      continue;
    }

    let state: DatastoreState | null;
    try {
      state = await adapter.observe(target, row.ref);
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
        permitted,
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

    reports.push({
      datastoreId: row.id,
      phase: state.phase,
      connected,
      permitted,
    });
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
