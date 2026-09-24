/**
 * `getDatastore` answers one Datastore's stored facts and the document its
 * backend holds. An unreachable backend leaves the facts readable and reports
 * the failure as `objectError`.
 */
import { z } from 'zod';
import type { Datastore, Vessel } from '../../db/schema.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import {
  datastoreVesselLabel,
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
} from '../../domain/target.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';
import type { DatastoreDetailView } from '../views.ts';
import { datastoreSurfaceTargetOf } from './vessel-surface.ts';

export const getDatastoreInput = z
  .object({
    datastoreId: z.uuid(),
  })
  .strict();

export type GetDatastoreInput = z.infer<typeof getDatastoreInput>;

export interface GetDatastoreResult {
  readonly datastore: DatastoreDetailView;
}

export const getDatastore: Command<
  GetDatastoreInput,
  GetDatastoreResult
> = async (input, context) => {
  const row = await context.db.query.datastores.findFirst({
    where: (datastores, { eq }) => eq(datastores.id, input.datastoreId),
    with: { app: true, vessel: true },
  });
  if (row === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Datastore with id ${input.datastoreId}`,
    );
  }

  const read = await describeDatastore(row, context);

  return ok({
    // Named fields only: a spread would ship connection_ref to the browser.
    datastore: {
      id: row.id,
      name: row.name,
      engine: row.engine,
      provenance: row.provenance,
      attachedTo: row.app === null ? null : row.app.name,
      target: datastoreVesselLabel(row.vessel),
      vesselId: row.vesselId,
      appId: row.appId,
      phase: row.phase,
      provisioned: row.ref !== null,
      ...(row.detail === null ? {} : { detail: row.detail }),
      when: elapsedSince(row.createdAt, context.clock.now()),
      at: row.createdAt.toISOString(),
      ...read,
    },
  });
};

type Described = Pick<DatastoreDetailView, 'object' | 'objectError'>;

/**
 * The backend's document. `object: null` with no error when there is nothing to
 * ask; only a call that threw sets `objectError`.
 */
async function describeDatastore(
  row: Datastore & { readonly vessel: Vessel },
  context: CommandContext,
): Promise<Described> {
  if (row.ref === null) return { object: null };
  const target = await datastoreSurfaceTargetOf(context.db, row.vessel);
  if (target === undefined) return { object: null };
  if (!hasTargetConnection(target) || !hasVesselLocation(row.vessel)) {
    return { object: null };
  }

  const adapter = context.adapters.datastore?.(target.adapter) ?? null;
  if (adapter?.describe === undefined) return { object: null };

  try {
    const object = await adapter.describe(
      deployTargetOf(target, row.vessel),
      row.ref,
    );
    if (object === null || object === undefined) return { object: null };
    // Two-space: this is shown to a reader, not parsed.
    return { object: JSON.stringify(object, null, 2) };
  } catch (cause) {
    return {
      object: null,
      objectError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
