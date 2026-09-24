/**
 * `destroyDatastore` tears a Datastore down and deletes its row. It refuses
 * while attached, and the adapter call comes first, so a refused teardown
 * changes nothing.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { datastores } from '../../db/schema.ts';
import {
  datastoreVesselLabel,
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
} from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';
import { datastoreSurfaceTargetOf } from './vessel-surface.ts';

export const destroyDatastoreInput = z
  .object({
    datastoreId: z.uuid(),
  })
  .strict();

export type DestroyDatastoreInput = z.infer<typeof destroyDatastoreInput>;

export interface DestroyDatastoreResult {
  readonly datastoreId: string;
  readonly name: string;
  /** False when only the row was removed: external, or never provisioned. */
  readonly destroyed: boolean;
}

export const destroyDatastore: Command<
  DestroyDatastoreInput,
  DestroyDatastoreResult
> = async (input, context) => {
  const datastore = await context.db.query.datastores.findFirst({
    where: (rows, { eq }) => eq(rows.id, input.datastoreId),
    with: { vessel: true },
  });
  if (datastore === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Datastore with id ${input.datastoreId}`,
    );
  }

  if (datastore.appId !== null) {
    return failed(
      'NOT_REMOVABLE',
      `'${datastore.name}' is attached to an App — detach it first`,
    );
  }

  // An external Datastore is someone else's database, and one with no ref was
  // never provisioned: both lose only the row.
  const ref = datastore.provenance === 'external' ? null : datastore.ref;
  if (ref !== null) {
    const target = await datastoreSurfaceTargetOf(context.db, datastore.vessel);
    if (target === undefined) {
      return failed(
        'NOT_REMOVABLE',
        `${datastoreVesselLabel(datastore.vessel)} has no surface Spindrift can tear a Datastore down through`,
      );
    }
    if (!hasTargetConnection(target) || !hasVesselLocation(datastore.vessel)) {
      return failed(
        'NOT_REMOVABLE',
        `${datastoreVesselLabel(datastore.vessel)} is not connected, so nothing can be torn down there`,
      );
    }
    const adapter = context.adapters.datastore?.(target.adapter) ?? null;
    if (adapter === null) {
      return failed(
        'NOT_REMOVABLE',
        `this installation has no ${target.adapter} datastore adapter`,
      );
    }
    try {
      await adapter.destroy(deployTargetOf(target, datastore.vessel), ref);
    } catch (cause) {
      return failed(
        'NOT_REMOVABLE',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  await context.db.delete(datastores).where(eq(datastores.id, datastore.id));

  return ok({
    datastoreId: datastore.id,
    name: datastore.name,
    destroyed: ref !== null,
  });
};
