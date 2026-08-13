/**
 * `attachDatastore` — bind an existing Datastore to an App (§11).
 *
 * §11 makes a Datastore "top-level and attached, not a field, forced by
 * reattachment to a different App", so attachment is its own act and this is
 * it. One column changes.
 *
 * **No adapter call, and nothing reaches a running container.** Attaching does
 * not restart anything: the connection is rendered into the workload's
 * environment by the deploy path, so the App picks it up on its **next
 * Deploy** and not before. That is the same promise config makes (§10) and it
 * is deliberate — an attach that silently rolled every Component would be a
 * destructive act hiding behind a bookkeeping verb.
 *
 * **Every refusal that could leave an App un-deployable lives here**, because
 * this is the last moment at which the state can be prevented rather than
 * diagnosed. Refusing at deploy time instead would leave a developer with an
 * App that cannot be released and no verb that undoes the reason:
 *
 * - *Already attached elsewhere.* A Datastore has one App. Reattachment is
 *   detach-then-attach, which is two deliberate acts rather than one that
 *   silently steals a database out from under another App.
 * - *A second store of the same engine.* Both would claim the same variable —
 *   the name is fixed by engine, `DATABASE_URL` for postgres and `REDIS_URL`
 *   for valkey — and the second would win by ordering. There is no field to
 *   rename either, by design.
 * - *A cluster-local Datastore under an App placed somewhere else.* §11:
 *   "In-cluster datastores stay cluster-local in v1." The refusal is worded in
 *   the placement screen's own words, because a developer told one thing when
 *   they picked a Target and something else when they attached a database is
 *   being told about two different systems.
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
  /** The variable the connection will arrive as, so the caller can say so. */
  readonly engine: 'postgres' | 'valkey';
}

/**
 * Placement's sentence for a cluster-local store, resolved once.
 *
 * `sentence` takes the derived requirements because most of its branches read
 * them; this branch reads none of the three, so the values below are inert and
 * exist only to satisfy the shape. Calling it anyway is the point — the words
 * a developer reads here are the same string the placement screen shows, kept
 * in one place rather than typed twice.
 */
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

  // Attaching where it already is changes nothing and refusing would make the
  // retry of a dropped response an error.
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

  // Cluster-local is a property of where the Datastore sits, derived exactly
  // as `resolveComponentPlacement` derives it: a managed cloud database is
  // reachable from anywhere its project is, one running in a cluster is
  // reachable from that cluster only. "This boundary is a cluster" is the
  // vessel's kind, stated directly rather than inferred back off a surface's
  // adapter. The join compares boundaries, not surface rows — the conceptually
  // right test, and an inner join so an unplaced Component (NULL
  // placedTargetId) constrains nothing, exactly as before.
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
