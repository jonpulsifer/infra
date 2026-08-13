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
 *
 * **The pickable Targets ride along.** `createDatastore` takes a Target and no
 * App, so the ledger can create — and the one thing its form needs that the
 * rows do not carry is where a new one could go. It is answered here rather
 * than by a second call to `listTargets` because that command answers a
 * different question (placement candidacy for a Component being created) and
 * carries none of §3's storage capabilities; a screen that asked it would be
 * offering Targets on a fact it never read.
 */
import { z } from 'zod';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import {
  hasTargetConnection,
  hasVesselLocation,
  targetRowLabel,
} from '../../domain/target.ts';
import type {
  DatastoreListItem,
  DatastoreTargetOption,
} from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const listDatastoresInput = z.object({}).strict();

export type ListDatastoresInput = z.infer<typeof listDatastoresInput>;

export interface ListDatastoresResult {
  readonly datastores: readonly DatastoreListItem[];
  /** Where a new managed Datastore could be created — see the file note. */
  readonly targets: readonly DatastoreTargetOption[];
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

  const targetRows = await context.db.query.targets.findMany({
    with: { vessel: true },
    orderBy: (row, { asc }) => [asc(row.rank)],
  });
  const targets: DatastoreTargetOption[] = [];
  for (const target of targetRows) {
    // Every check `createDatastore` makes before it inserts, in its order. A
    // Target that fails any of them is one whose only answer is that command's
    // refusal, and an option whose sole outcome is a refusal is worth less
    // than not offering it.
    if (!hasTargetConnection(target) || !hasVesselLocation(target.vessel)) {
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
    targets.push({
      targetId: target.id,
      label: targetRowLabel(target),
      engines,
    });
  }

  return ok({
    targets,
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
