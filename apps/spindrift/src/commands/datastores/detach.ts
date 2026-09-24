/**
 * `detachDatastore` unbinds a Datastore from its App and destroys nothing: the
 * row outlives the App. Detaching a detached Datastore is not an error.
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
