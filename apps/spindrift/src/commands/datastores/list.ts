/**
 * `listDatastores` — every Datastore this installation holds, newest first.
 *
 * §11 makes a Datastore "top-level and attached, not a field", and until now
 * that was true of the row and false of the UI: the only read path was
 * `getAppWorkspace`, scoped to one App, which is exactly wrong for the
 * question this command answers — "what storage exists, and what is it
 * doing" has nothing to do with which App a reader happened to open first.
 * `createDatastore`, `attachDatastore`, `detachDatastore` and
 * `destroyDatastore` have all existed with no ledger to act from except that
 * one App's workspace.
 *
 * **Every field is named on the way out, never spread.** `datastores` carries
 * `connection_ref` — the pointer to a Secret, per `web/model.ts`'s note on
 * `DatastoreView` — and a `select()` or a spread would ship it to the browser
 * the moment this file forgot to think about it. The command layer's one rule
 * for a credential-adjacent column is that nothing reaches across it by
 * accident, so the row is read in full and only named fields leave.
 *
 * No pagination. Datastores are created by hand, one at a time, through a
 * form with a name field — there will be tens of them for the lifetime of an
 * installation, not the thousands a Build or a Deploy accumulates.
 */
import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import { targetRowLabel } from '../../domain/target.ts';
import type { DatastoreListItem } from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const listDatastoresInput = z.object({}).strict();

export type ListDatastoresInput = z.infer<typeof listDatastoresInput>;

export interface ListDatastoresResult {
  readonly datastores: readonly DatastoreListItem[];
}

export const listDatastores: Command<
  ListDatastoresInput,
  ListDatastoresResult
> = async (_input, context) => {
  const now = context.clock.now();
  const rows = await context.db.query.datastores.findMany({
    with: { app: true, target: { with: { vessel: true } } },
    orderBy: (row, { desc }) => [desc(row.createdAt)],
  });

  return ok({
    datastores: rows.map((row) => ({
      id: row.id,
      name: row.name,
      engine: row.engine,
      provenance: row.provenance,
      attachedTo: row.app === null ? null : row.app.name,
      target: targetRowLabel(row.target),
      targetId: row.targetId,
      appId: row.appId,
      phase: row.phase,
      // §11's `ref` is the adapter's own handle, opaque here — this only ever
      // asks whether one was returned, the same test `destroyDatastore`
      // makes to decide whether it owes the adapter a call.
      provisioned: row.ref !== null,
      ...(row.detail === null ? {} : { detail: row.detail }),
      when: elapsedSince(row.createdAt, now),
      at: row.createdAt.toISOString(),
    })),
  });
};
