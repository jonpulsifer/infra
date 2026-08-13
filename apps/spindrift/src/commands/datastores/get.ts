/**
 * `getDatastore` — one Datastore, and what its backend says about it (§11).
 *
 * `listDatastores` answers "what storage exists"; this answers "what is this
 * one, actually". The split is the same one Builds and Deploys already have —
 * a ledger of rows and a screen per object — and a Datastore earns it for the
 * reason §11 makes it top-level: it is a thing an operator diagnoses, not a
 * field on the App that happens to read it.
 *
 * **The document comes from the far side, never from core.** `describe` returns
 * the object the API server holds, so what a reader sees is what the operator
 * is reconciling — spec, defaults it filled in, and the `status` that is the
 * only place a stuck Datastore's reason is written. Core could not compose an
 * equivalent even if it wanted to: `createDatastore` states "no size on the
 * row", so a manifest rendered here would state a `storageGiB` nothing stored.
 *
 * **A backend that cannot be reached does not take the screen down.** Every
 * stored fact is answered first and the read is wrapped, because the state
 * where a Target is unreachable is exactly the state where the rest of this is
 * worth reading. The failure travels as `objectError` — a sentence, beside the
 * facts — rather than as this command's refusal.
 */
import { z } from 'zod';
import type { Datastore, Target, Vessel } from '../../db/schema.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  targetRowLabel,
} from '../../domain/target.ts';
import type { DatastoreDetailView } from '../../web/model.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

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
    with: { app: true, target: { with: { vessel: true } } },
  });
  if (row === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Datastore with id ${input.datastoreId}`,
    );
  }

  const read = await describeDatastore(row, context);

  return ok({
    // Named field by field, never spread — `listDatastores`' rule, for the
    // `connection_ref` column it exists to keep on this side of the seam.
    datastore: {
      id: row.id,
      name: row.name,
      engine: row.engine,
      provenance: row.provenance,
      attachedTo: row.app === null ? null : row.app.name,
      target: targetRowLabel(row.target),
      targetId: row.targetId,
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
 * The backend's document, or the reason there is not one.
 *
 * Every "there is nothing to read" case answers `object: null` with no
 * sentence, because none of them is a fault: an `external` Datastore was never
 * provisioned, a `managed` one mid-provision has no handle yet, a disconnected
 * Target has nothing to ask, and the cloud backend implements no `describe` at
 * all. Only a call that threw produces `objectError`.
 */
async function describeDatastore(
  row: Datastore & { readonly target: Target & { readonly vessel: Vessel } },
  context: CommandContext,
): Promise<Described> {
  if (row.ref === null) return { object: null };
  const target = row.target;
  if (!hasTargetConnection(target) || !hasVesselLocation(target.vessel)) {
    return { object: null };
  }

  const adapter = context.adapters.datastore?.(target.adapter) ?? null;
  if (adapter?.describe === undefined) return { object: null };

  try {
    const object = await adapter.describe(
      deployTargetOf(target, target.vessel),
      row.ref,
    );
    if (object === null || object === undefined) return { object: null };
    // Two-space, because this is read rather than parsed — the one place in
    // core where the indentation is the point.
    return { object: JSON.stringify(object, null, 2) };
  } catch (cause) {
    return {
      object: null,
      objectError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
