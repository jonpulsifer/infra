/**
 * Polls each managed Datastore's `observe` into its row, and keeps the network
 * exception admitting the attached App's namespace in step with `app_id`.
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
import { logWarn, reconcilerLoopDuration } from '../telemetry/index.ts';

// `permitted_namespace` is memory, not observation. Re-applying hourly restores
// a policy deleted out of band, at one idempotent apply per Datastore.
const PERMIT_REASSERT_MS = 60 * 60 * 1000;

export interface DatastoreLoopContext {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly clock: { now(): Date };
}

export interface DatastoreReport {
  readonly datastoreId: string;
  readonly phase: DeployPhase;
  /** True when this pass first recorded the connection reference. */
  readonly connected: boolean;
  /** True when this pass applied the network exception. */
  readonly permitted: boolean;
}

export async function runDatastorePass(
  context: DatastoreLoopContext,
): Promise<readonly DatastoreReport[]> {
  // Settled rows too: a settled Datastore's attachment can still change.
  // ponytail: a full scan of the managed rows per pass, and no re-observe of a
  // settled one. Index `(provenance, ref)` if a fleet ever holds hundreds.
  const rows = await context.db
    .select({
      id: datastores.id,
      ref: datastores.ref,
      phase: datastores.phase,
      connectionRef: datastores.connectionRef,
      permittedNamespace: datastores.permittedNamespace,
      permittedAt: datastores.permittedAt,
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
        // `DATASTORE_SURFACE_BY_VESSEL_KIND` in SQL, so a pass is one query.
        or(
          and(eq(vessels.kind, 'cluster'), eq(targets.adapter, 'kubernetes')),
          and(eq(vessels.kind, 'gcp-project'), eq(targets.adapter, 'cloudrun')),
        ),
      ),
    )
    // Left: a detached Datastore's exception still has to be revoked.
    .leftJoin(apps, eq(datastores.appId, apps.id))
    .where(
      and(eq(datastores.provenance, 'managed'), isNotNull(datastores.ref)),
    );

  const reports: DatastoreReport[] = [];
  for (const row of rows) {
    const connection = row.target.connection;
    const location = row.vessel.location;
    const adapter = context.adapters.datastore?.(row.target.adapter) ?? null;
    // An unaddressable Target or a missing adapter is this installation's gap,
    // not the database's, so it is skipped and never marked FAILED.
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

    // Converged here, not in the attach commands: deleting an App nulls
    // `app_id` with no command in the path. Runs before the poll's early exits.
    const desired =
      row.appName === null || connection.adapter !== 'kubernetes'
        ? null
        : appNamespaceFor(connection, row.appName);
    const now = context.clock.now();
    // Only a desired exception is re-applied: a lost revoke fails closed.
    const stale =
      desired !== null &&
      (row.permittedAt === null ||
        now.getTime() - row.permittedAt.getTime() >= PERMIT_REASSERT_MS);
    let permitted = false;
    if (
      adapter.permit !== undefined &&
      (desired !== row.permittedNamespace || stale)
    ) {
      try {
        // `false`: the adapter wrote nothing, so the namespace is not recorded.
        permitted = await adapter.permit(
          target,
          row.ref,
          desired === null ? [] : [desired],
        );
      } catch (error) {
        // Not a `continue`: the poll below still runs, and the unrecorded
        // write is retried next pass.
        logWarn('a Datastore network exception was refused', {
          'spindrift.datastore.id': row.id,
          'spindrift.datastore.namespace': desired ?? '(none)',
          'spindrift.target': targetLabel({
            vessel: row.vessel.name,
            adapter: row.target.adapter,
          }),
          'spindrift.error':
            error instanceof Error ? error.message : String(error),
        });
      }
      if (permitted) {
        await context.db
          .update(datastores)
          .set({ permittedNamespace: desired, permittedAt: now })
          .where(eq(datastores.id, row.id));
      }
    }

    // Settled: LIVE with a connection reference leaves nothing to observe.
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
      // An unreachable Target has not lost its database; the next pass retries.
      continue;
    }

    // Deleted out of band: FAILED, never silently re-provisioned.
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
        // Null throughout a healthy provision. Omitted when null, so a later
        // pass never clears a reference a Deploy has pinned.
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

export interface DatastoreLoopOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (reports: readonly DatastoreReport[]) => void;
}

// Fast, because a developer waits to attach. A pass reads only unsettled rows.
export const DEFAULT_DATASTORE_INTERVAL_MS = 15_000;

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
