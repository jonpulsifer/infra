/**
 * `createDatastore` — provision a managed Datastore on a Target (§11).
 *
 * The caller of `DatastoreAdapter.provision`, which until now had none: the
 * contract, both backends and the capability discovery were all complete and
 * nothing ever asked them for a database.
 *
 * **The row is inserted before the adapter is called**, which is the one
 * ordering decision in this file. Every other create-then-call command in this
 * layer does it the other way round — `unplaceComponent` calls `destroy`
 * first so a refusal leaves nothing to unwind — and the reason this one is
 * inverted is the unique key on (target_id, name). Two Datastores of one name
 * on one Target are one object on the far side: the adapter names what it
 * provisions after the Datastore, so a server-side apply of the second adopts
 * the first, and a later destroy of either takes the other's storage. Only the
 * database can decide that race. Inserting first makes a colliding name a
 * constraint violation *before* anything exists in the cluster to collide
 * with; calling first would create the object and then discover it was not
 * ours. The insert is undone when `provision` throws, so a refusal still
 * leaves no row behind.
 *
 * **No `appId`.** A Datastore is top-level and attached (§11), and
 * `attachDatastore` is where the attachment rules live — one Postgres per App,
 * cluster-local placement, an App whose Components sit elsewhere. Accepting an
 * App here would mean those rules existing in two places, and the second copy
 * is the one that goes stale. The UI creates and then attaches; if the attach
 * refuses, the row is visible and unattached, which is the honest state.
 *
 * **No size on the row.** `storageGiB` is an input because every backend
 * demands one and none of them has a default worth inheriting, and it is not a
 * column because `provision` is called exactly once, from here, with the value
 * already in hand. A resize command would add the column and be the thing that
 * needs it.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { DatastoreEngine } from '../../adapters/datastore/contract.ts';
import { datastores } from '../../db/schema.ts';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  targetRowLabel,
} from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const createDatastoreInput = z
  .object({
    name: z.string().min(1),
    engine: z.enum(['postgres', 'valkey']),
    targetId: z.uuid(),
    /**
     * Reachable over the API and absent from every screen, deliberately. §11
     * gives a Datastore no size control, and a form field for one would be a
     * decision a developer has no basis to make on the day they create it.
     */
    storageGiB: z.number().int().min(1).default(10),
  })
  .strict();

export type CreateDatastoreInput = z.infer<typeof createDatastoreInput>;

export interface CreateDatastoreResult {
  readonly id: string;
  readonly name: string;
  readonly engine: DatastoreEngine;
  readonly targetId: string;
  /** The adapter's handle, which the reconcile loop polls from here on. */
  readonly ref: string;
}

export const createDatastore: Command<
  CreateDatastoreInput,
  CreateDatastoreResult
> = async (input, context) => {
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, input.targetId),
    with: { vessel: true },
  });
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no Target with id ${input.targetId}`);
  }

  if (!hasTargetConnection(target) || !hasVesselLocation(target.vessel)) {
    return failed(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} is not connected, so nothing can be provisioned there`,
    );
  }

  // The same fact placement reads (`domain/placement.ts`'s
  // `DATASTORE_ENGINE_MISSING`), asked here so a Datastore is never created on
  // a Target that would then exclude every Component attached to it. §3's
  // capability, not the adapter's `engines` list: that one says the code knows
  // how to write the object, this one says the cluster serves the operator.
  const capabilities = capabilitiesOfRow(target, {
    artifactTypes:
      context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
    manifest: context.manifest,
  });
  const served =
    input.engine === 'postgres' ? capabilities.postgres : capabilities.valkey;
  if (!served) {
    return failed(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} does not serve ${input.engine}`,
    );
  }

  // Optional on the registry, so `?.` rather than a call: a context assembled
  // before this seam existed has no `datastore` key at all, and reaching a
  // missing method is the crash this command exists above.
  const adapter = context.adapters.datastore?.(target.adapter) ?? null;
  if (adapter === null) {
    return failed(
      'NOT_DEPLOYABLE',
      `this installation has no ${target.adapter} datastore adapter`,
    );
  }

  const now = context.clock.now();
  let inserted: readonly { id: string }[];
  try {
    inserted = await context.db
      .insert(datastores)
      .values({
        name: input.name,
        engine: input.engine,
        provenance: 'managed',
        targetId: target.id,
        phase: 'PENDING',
        ref: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: datastores.id });
  } catch {
    // The unique key is the only constraint this insert can violate, and the
    // sentence names the pair it is keyed on rather than repeating Postgres'
    // — an operator reads "already a Datastore called x here", not a
    // constraint name.
    return failed(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} already has a Datastore called '${input.name}'`,
    );
  }
  const id = inserted[0]?.id;
  if (id === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      'the Datastore record could not be written',
    );
  }

  let ref: string;
  try {
    ref = await adapter.provision(deployTargetOf(target, target.vessel), {
      name: input.name,
      engine: input.engine,
      storageGiB: input.storageGiB,
    });
  } catch (cause) {
    // Where `CloudDatastoreAdapter`'s `UNIMPLEMENTED` sentence surfaces as a
    // refusal instead of a 500 — a Vessel carries no network to place a
    // private endpoint in, and the honest answer is the adapter's own words.
    await context.db.delete(datastores).where(eq(datastores.id, id));
    return failed(
      'NOT_DEPLOYABLE',
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  await context.db
    .update(datastores)
    .set({ ref, updatedAt: now })
    .where(eq(datastores.id, id));

  return ok({
    id,
    name: input.name,
    engine: input.engine,
    targetId: target.id,
    ref,
  });
};
