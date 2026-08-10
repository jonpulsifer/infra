/**
 * `destroyDatastore` — tear a Datastore down and forget it (§11, §13).
 *
 * The same deliberate exception `unplaceComponent` argues for, in the same
 * words: §13's rule is "never destroy as a side effect of something else", and
 * this command's *entire subject* is the destruction. An operator who calls it
 * is not tidying bookkeeping and getting a surprise teardown — the teardown is
 * what they asked for by name. `deleteApp` and `detachDatastore` both decline
 * to call the adapter for exactly that reason, and neither of their subjects is
 * the database.
 *
 * **Refuses while attached.** A Datastore under a live App is storage
 * something is still reading; detaching first is one extra act and is the act
 * that states the intent. It is also the only refusal here that a caller can
 * do something about without leaving the screen.
 *
 * **Two rows never reach the adapter.** An `external` Datastore was never
 * provisioned — §11 gives the two provenances as "differing only in who
 * authors the URL", and destroying somebody else's database because they
 * pasted its URL here would be the most destructive possible reading of
 * "remove this record". A row with no `ref` was never successfully
 * provisioned, so there is no handle to hand `destroy` and nothing on the far
 * side that answers to it. Both delete the row and call nothing.
 *
 * **A refused teardown leaves everything as it was.** The adapter call happens
 * before the row is touched, so a thrown error returns a failure with nothing
 * to unwind and pressing the button again is the retry.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { datastores } from '../../db/schema.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  targetRowLabel,
} from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const destroyDatastoreInput = z
  .object({
    datastoreId: z.uuid(),
  })
  .strict();

export type DestroyDatastoreInput = z.infer<typeof destroyDatastoreInput>;

export interface DestroyDatastoreResult {
  readonly datastoreId: string;
  readonly name: string;
  /**
   * Whether a ref was found and handed to `destroy`.
   *
   * `false` means the record was removed with no adapter call — an `external`
   * Datastore, or a `managed` one whose provision never returned a handle.
   */
  readonly destroyed: boolean;
}

export const destroyDatastore: Command<
  DestroyDatastoreInput,
  DestroyDatastoreResult
> = async (input, context) => {
  const datastore = await context.db.query.datastores.findFirst({
    where: (rows, { eq }) => eq(rows.id, input.datastoreId),
    with: { target: { with: { vessel: true } } },
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

  const ref = datastore.provenance === 'external' ? null : datastore.ref;
  if (ref !== null) {
    const target = datastore.target;
    if (!hasTargetConnection(target) || !hasVesselLocation(target.vessel)) {
      return failed(
        'NOT_REMOVABLE',
        `${targetRowLabel(target)} is not connected, so nothing can be torn down there`,
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
      await adapter.destroy(deployTargetOf(target, target.vessel), ref);
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
