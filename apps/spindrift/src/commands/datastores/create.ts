/**
 * `createDatastore` provisions a managed Datastore in a vessel, on the one
 * surface there that can host it. Attaching it to an App is `attachDatastore`'s
 * job.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DatastoreEngine } from '../../adapters/datastore/contract.ts';
import { datastores } from '../../db/schema.ts';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import {
  datastoreVesselLabel,
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
} from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';
import { datastoreSurfaceTargetOf } from './vessel-surface.ts';

export const createDatastoreInput = z
  .object({
    name: z.string().min(1),
    engine: z.enum(['postgres', 'valkey']),
    vesselId: z.uuid(),
    /** API only, and not stored: `provision` is called once, from here. */
    storageGiB: z.number().int().min(1).default(10),
  })
  .strict();

export type CreateDatastoreInput = z.infer<typeof createDatastoreInput>;

export interface CreateDatastoreResult {
  readonly id: string;
  readonly name: string;
  readonly engine: DatastoreEngine;
  readonly vesselId: string;
  /** The adapter's handle, which the reconcile loop polls from here on. */
  readonly ref: string;
}

export const createDatastore: Command<
  CreateDatastoreInput,
  CreateDatastoreResult
> = async (input, context) => {
  const vessel = await context.db.query.vessels.findFirst({
    where: (vessels, { eq }) => eq(vessels.id, input.vesselId),
  });
  if (vessel === undefined) {
    return failed('NOT_FOUND', `there is no Vessel with id ${input.vesselId}`);
  }

  // The adapter addresses the surface through its Target. None means the vessel
  // kind never hosts a database, or its hosting surface was never probed.
  const target = await datastoreSurfaceTargetOf(context.db, vessel);
  if (target === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      `${vessel.name} has no surface Spindrift can host a Datastore on`,
    );
  }

  if (!hasTargetConnection(target) || !hasVesselLocation(vessel)) {
    return failed(
      'NOT_DEPLOYABLE',
      `${datastoreVesselLabel(vessel)} is not connected, so nothing can be provisioned there`,
    );
  }

  // Placement excludes a Target without this capability, which says the cluster
  // runs the engine's operator, so no Component could use a Datastore here.
  const capabilities = capabilitiesOfRow(target, {
    artifactTypes:
      context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
    manifest: context.manifest,
  });
  const served =
    input.engine === 'postgres' ? capabilities.postgres : capabilities.valkey;
  if (!served) {
    return failed(
      'NOT_DEPLOYABLE',
      `${datastoreVesselLabel(vessel)} does not serve ${input.engine}`,
    );
  }

  const adapter = context.adapters.datastore?.(target.adapter) ?? null;
  if (adapter === null) {
    return failed(
      'NOT_DEPLOYABLE',
      `this installation has no ${target.adapter} datastore adapter`,
    );
  }

  // Inserted first: the far-side object is named after the Datastore, so only
  // the unique key on (vessel_id, name) can refuse a duplicate.
  const now = context.clock.now();
  let inserted: readonly { id: string }[];
  try {
    inserted = await context.db
      .insert(datastores)
      .values({
        name: input.name,
        engine: input.engine,
        provenance: 'managed',
        vesselId: vessel.id,
        phase: 'PENDING',
        ref: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datastores.id });
  } catch {
    // The unique key is the only constraint this insert can violate.
    return failed(
      'NOT_DEPLOYABLE',
      `${datastoreVesselLabel(vessel)} already has a Datastore called '${input.name}'`,
    );
  }
  const id = inserted[0]?.id;
  if (id === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      'the Datastore record could not be written',
    );
  }

  let ref: string;
  try {
    ref = await adapter.provision(deployTargetOf(target, vessel), {
      name: input.name,
      engine: input.engine,
      storageGiB: input.storageGiB,
    });
  } catch (cause) {
    await context.db.delete(datastores).where(eq(datastores.id, id));
    return failed(
      'NOT_DEPLOYABLE',
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  await context.db
    .update(datastores)
    .set({ ref, updatedAt: now })
    .where(eq(datastores.id, id));

  return ok({
    id,
    name: input.name,
    engine: input.engine,
    vesselId: vessel.id,
    ref,
  });
};
