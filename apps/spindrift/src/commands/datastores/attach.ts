/**
 * `attachDatastore` binds an existing Datastore to an App. Nothing restarts:
 * the App gets the connection on its next Deploy. Every refusal that would
 * leave the App undeployable is made here, where it can still be prevented.
 */
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { apps, components, datastores, targets } from '../../db/schema.ts';
import { DEFAULT_PLATFORM, sentence } from '../../domain/placement.ts';
import { datastoreVesselLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const attachDatastoreInput = z
  .object({
    datastoreId: z.uuid(),
    appId: z.uuid(),
  })
  .strict();

export type AttachDatastoreInput = z.infer<typeof attachDatastoreInput>;

export interface AttachDatastoreResult {
  readonly datastoreId: string;
  readonly appId: string;
  /** The engine fixes the variable the connection arrives as. */
  readonly engine: 'postgres' | 'valkey';
}

/** Placement's own sentence; this branch of `sentence` ignores the rest. */
const CLUSTER_LOCAL = sentence('DATASTORE_IS_CLUSTER_LOCAL', {
  kind: 'service',
  reach: 'none',
  platform: DEFAULT_PLATFORM,
});

export const attachDatastore: Command<
  AttachDatastoreInput,
  AttachDatastoreResult
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

  const [app] = await context.db
    .select()
    .from(apps)
    .where(eq(apps.id, input.appId));
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  // Idempotent, so retrying a dropped response is not an error.
  if (datastore.appId === app.id) {
    return ok({
      datastoreId: datastore.id,
      appId: app.id,
      engine: datastore.engine,
    });
  }
  if (datastore.appId !== null) {
    return failed(
      'NOT_DEPLOYABLE',
      `'${datastore.name}' is attached to another App — detach it first`,
    );
  }

  const [collision] = await context.db
    .select({ name: datastores.name })
    .from(datastores)
    .where(
      and(
        eq(datastores.appId, app.id),
        eq(datastores.engine, datastore.engine),
        ne(datastores.id, datastore.id),
      ),
    );
  if (collision !== undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      `'${app.name}' already has a ${datastore.engine} Datastore attached ('${collision.name}'), and both would arrive as the same variable`,
    );
  }

  // A cluster vessel's Datastore is reachable from that vessel only. The inner
  // join skips unplaced Components, which constrain nothing.
  if (datastore.vessel.kind === 'cluster') {
    const [elsewhere] = await context.db
      .select({
        name: components.name,
        placedTargetId: components.placedTargetId,
      })
      .from(components)
      .innerJoin(targets, eq(components.placedTargetId, targets.id))
      .where(
        and(
          eq(components.appId, app.id),
          ne(targets.vesselId, datastore.vesselId),
        ),
      );
    if (elsewhere !== undefined) {
      return failed(
        'NOT_DEPLOYABLE',
        `${CLUSTER_LOCAL}: '${datastore.name}' is on ${datastoreVesselLabel(datastore.vessel)} and '${elsewhere.name}' is not`,
      );
    }
  }

  await context.db
    .update(datastores)
    .set({ appId: app.id, updatedAt: context.clock.now() })
    .where(eq(datastores.id, datastore.id));

  return ok({
    datastoreId: datastore.id,
    appId: app.id,
    engine: datastore.engine,
  });
};
