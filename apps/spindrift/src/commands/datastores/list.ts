/**
 * `listDatastores` lists every Datastore in the installation, newest first,
 * with the vessels a new one could be created in. No pagination: Datastores are
 * made by hand, tens per installation.
 */
import { z } from 'zod';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import {
  datastoreVesselLabel,
  hasTargetConnection,
  hasVesselLocation,
} from '../../domain/target.ts';
import { type Command, ok } from '../types.ts';
import type { DatastoreListItem, DatastoreVesselOption } from '../views.ts';
import { datastoreSurfaceTargetOf } from './vessel-surface.ts';

export const listDatastoresInput = z.object({}).strict();

export type ListDatastoresInput = z.infer<typeof listDatastoresInput>;

export interface ListDatastoresResult {
  readonly datastores: readonly DatastoreListItem[];
  /** Where a new managed Datastore could be created. */
  readonly vessels: readonly DatastoreVesselOption[];
}

export const listDatastores: Command<
  ListDatastoresInput,
  ListDatastoresResult
> = async (_input, context) => {
  const now = context.clock.now();
  const rows = await context.db.query.datastores.findMany({
    with: { app: true, vessel: true },
    orderBy: (row, { desc }) => [desc(row.createdAt)],
  });

  // By name: rank lives on surfaces, not vessels.
  const vesselRows = await context.db.query.vessels.findMany({
    orderBy: (row, { asc }) => [asc(row.name)],
  });
  const vessels: DatastoreVesselOption[] = [];
  for (const vessel of vesselRows) {
    // The checks createDatastore makes, in its order; a vessel it would refuse
    // is not offered.
    const target = await datastoreSurfaceTargetOf(context.db, vessel);
    if (target === undefined) continue;
    if (!hasTargetConnection(target) || !hasVesselLocation(vessel)) {
      continue;
    }
    if ((context.adapters.datastore?.(target.adapter) ?? null) === null) {
      continue;
    }
    const capabilities = capabilitiesOfRow(target, {
      artifactTypes:
        context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
      manifest: context.manifest,
    });
    const engines = (['postgres', 'valkey'] as const).filter(
      (engine) => capabilities[engine],
    );
    if (engines.length === 0) continue;
    vessels.push({
      vesselId: vessel.id,
      label: datastoreVesselLabel(vessel),
      engines,
    });
  }

  return ok({
    vessels,
    // Named fields only: a spread would ship connection_ref to the browser.
    datastores: rows.map((row) => ({
      id: row.id,
      name: row.name,
      engine: row.engine,
      provenance: row.provenance,
      attachedTo: row.app === null ? null : row.app.name,
      target: datastoreVesselLabel(row.vessel),
      vesselId: row.vesselId,
      appId: row.appId,
      phase: row.phase,
      // `ref` is the adapter's opaque handle; only its presence is read.
      provisioned: row.ref !== null,
      ...(row.detail === null ? {} : { detail: row.detail }),
      when: elapsedSince(row.createdAt, now),
      at: row.createdAt.toISOString(),
    })),
  });
};
