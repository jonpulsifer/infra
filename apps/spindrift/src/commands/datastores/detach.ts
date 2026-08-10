/**
 * `detachDatastore` — unbind a Datastore from its App (§11).
 *
 * §2: "deleting an App detaches its Datastores and never cascades." Detachment
 * is `app_id = null` and the row survives, which is the whole reason the
 * column is nullable — a Datastore outlives every App that was ever attached
 * to it.
 *
 * **Destroys nothing**, and that is the point rather than an omission. §13's
 * rule is that nothing is torn down as a side effect of something else, and
 * "stop using this database" is not "delete this database": the operator who
 * wants the storage gone says `destroyDatastore`, by name, and this command
 * refuses to do it for them.
 *
 * Idempotent. Detaching what is already detached is what a retried request
 * looks like, and there is nothing about it to report as an error.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { datastores } from '../../db/schema.ts';
import { type Command, failed, ok } from '../types.ts';

export const detachDatastoreInput = z
  .object({
    datastoreId: z.uuid(),
  })
  .strict();

export type DetachDatastoreInput = z.infer<typeof detachDatastoreInput>;

export interface DetachDatastoreResult {
  readonly datastoreId: string;
  /** The App it was attached to, or `null` when it already was not. */
  readonly detachedFrom: string | null;
}

export const detachDatastore: Command<
  DetachDatastoreInput,
  DetachDatastoreResult
> = async (input, context) => {
  const [datastore] = await context.db
    .select()
    .from(datastores)
    .where(eq(datastores.id, input.datastoreId));
  if (datastore === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Datastore with id ${input.datastoreId}`,
    );
  }

  if (datastore.appId !== null) {
    await context.db
      .update(datastores)
      .set({ appId: null, updatedAt: context.clock.now() })
      .where(eq(datastores.id, datastore.id));
  }

  return ok({
    datastoreId: datastore.id,
    detachedFrom: datastore.appId,
  });
};
