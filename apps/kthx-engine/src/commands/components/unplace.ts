/**
 * Stops one Component@Target placement: destroys its workload, then retracts the
 * rows. A destroy that throws leaves every row as it was, for a retry.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  components,
  componentTargetDesired,
  deploys,
  vessels,
} from '../../db/schema.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  targetRowLabel,
} from '../../domain/target.ts';
import { dnsHandleFor } from '../../domain/workload-name.ts';
import { type Command, failed, ok } from '../types.ts';

export const unplaceComponentInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
  })
  .strict();

export type UnplaceComponentInput = z.infer<typeof unplaceComponentInput>;

export interface UnplaceComponentResult {
  readonly componentId: string;
  readonly targetId: string;
  /** `false` when the pair had no live ref, so no adapter call was made. */
  readonly destroyed: boolean;
}

export const unplaceComponent: Command<
  UnplaceComponentInput,
  UnplaceComponentResult
> = async (input, context) => {
  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, input.componentId));
  if (component === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }
  const [app] = await context.db
    .select({ name: apps.name })
    .from(apps)
    .where(eq(apps.id, component.appId));

  // With its vessel, because part of a Target's label lives there.
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, input.targetId),
    with: { vessel: true },
  });
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no Target with id ${input.targetId}`);
  }

  const [desired] = await context.db
    .select()
    .from(componentTargetDesired)
    .where(
      and(
        eq(componentTargetDesired.componentId, input.componentId),
        eq(componentTargetDesired.targetId, input.targetId),
      ),
    );
  if (desired === undefined) {
    return failed(
      'NOT_FOUND',
      `'${component.name}' is not placed on ${targetRowLabel(target)}`,
    );
  }

  // The newest non-orphaned Deploy's ref: a failed attempt keeps the ref it had.
  // Orphaned rows belong to an earlier disconnect or unplace.
  const [live] = await context.db
    .select({ ref: deploys.ref, vessel: vessels })
    .from(deploys)
    .innerJoin(vessels, eq(vessels.id, target.vesselId))
    .where(
      and(
        eq(deploys.componentId, input.componentId),
        eq(deploys.targetId, input.targetId),
        isNull(deploys.orphanedAt),
      ),
    )
    .orderBy(desc(deploys.id))
    .limit(1);

  const ref = live?.ref ?? null;
  if (ref !== null) {
    if (
      live === undefined ||
      !hasTargetConnection(target) ||
      !hasVesselLocation(live.vessel)
    ) {
      return failed(
        'NOT_REMOVABLE',
        `${targetRowLabel(target)} is not connected, so nothing can be torn down there`,
      );
    }
    const adapter = context.adapters.deploy(target.adapter);
    if (adapter === null) {
      return failed(
        'NOT_REMOVABLE',
        `this installation has no ${target.adapter} adapter`,
      );
    }
    // Caught before any row is touched, so a failed destroy leaves the placement
    // in place for a retry.
    try {
      await adapter.destroy(deployTargetOf(target, live.vessel), ref);
    } catch (cause) {
      return failed(
        'NOT_REMOVABLE',
        cause instanceof Error ? cause.message : String(cause),
      );
    }

    // `withdraw` is idempotent, so it runs after every destroy, even where no
    // record was published. Best effort: the workload is already gone.
    try {
      await context.adapters
        .dns?.()
        ?.withdraw(dnsHandleFor(app!.name, component.name));
    } catch {
      // Converges the next time this handle is published or withdrawn.
    }
  }

  const now = context.clock.now();
  await context.db.transaction(async (tx) => {
    // Nothing references this row, so it goes first; the Deploys stay as history.
    await tx
      .delete(componentTargetDesired)
      .where(eq(componentTargetDesired.id, desired.id));
    // Clears only when this pair is the placement of record. Retiring an old pair
    // after a move leaves the Component where it now is.
    await tx
      .update(components)
      .set({ placedTargetId: null, updatedAt: now })
      .where(
        and(
          eq(components.id, input.componentId),
          eq(components.placedTargetId, input.targetId),
        ),
      );
    await tx
      .update(deploys)
      .set({ orphanedAt: now, updatedAt: now })
      .where(
        and(
          eq(deploys.componentId, input.componentId),
          eq(deploys.targetId, input.targetId),
          isNull(deploys.orphanedAt),
        ),
      );
  });

  return ok({
    componentId: component.id,
    targetId: target.id,
    destroyed: ref !== null,
  });
};
