/**
 * Moves a Component to a Target. It carries the references a shared store allows,
 * refuses while any key that cannot follow is unsupplied, then writes the placement.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  components,
  componentTargetDesired,
  targets,
  vessels,
} from '../../db/schema.ts';
import { VARIABLE_NAME } from '../../domain/config.ts';
import { targetLabel } from '../../domain/target.ts';
import { carryReferences } from '../config/carry.ts';
import { demandSentence, migrationFor } from '../config/migration.ts';
import {
  applyConfigChange,
  type ConfigChangeResult,
  configSubject,
} from '../config/set.ts';
import { type Command, failed, ok } from '../types.ts';

export const placeComponentInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /** Values for the keys that will not follow, supplied in the same call. */
    supply: z
      .array(
        z
          .object({
            key: z
              .string()
              .regex(VARIABLE_NAME, 'must be an environment variable name'),
            value: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type PlaceComponentInput = z.infer<typeof placeComponentInput>;

export interface PlaceComponentResult extends ConfigChangeResult {
  /** Null when nothing was configured on another Target. */
  readonly carriedFrom: string | null;
  /** Keys whose pinned references moved; no value crossed. */
  readonly carried: readonly string[];
}

export const placeComponent: Command<
  PlaceComponentInput,
  PlaceComponentResult
> = async (input, context) => {
  const subject = await configSubject(context, input);
  if ('failure' in subject) return { ok: false, failure: subject.failure };

  const migration = await migrationFor(
    context.db,
    context,
    input.componentId,
    input.targetId,
  );

  const supplied = new Set(input.supply.map((entry) => entry.key));
  const missing = migration.demanded.filter((key) => !supplied.has(key));
  if (missing.length > 0) {
    const [target] = await context.db
      .select({ vessel: vessels.name, adapter: targets.adapter })
      .from(targets)
      .innerJoin(vessels, eq(vessels.id, targets.vesselId))
      .where(eq(targets.id, input.targetId));
    // The keys go in the issues as well as the sentence, so the move form can
    // collect them without parsing prose.
    return failed(
      'NOT_DEPLOYABLE',
      demandSentence(
        missing,
        target === undefined ? input.targetId : targetLabel(target),
      ),
      missing.map((key) => ({
        path: `supply.${key}`,
        message: 'must be supplied to finish the move',
      })),
    );
  }

  const carried = await carryReferences(context, subject, migration.follows);

  // Supplied values take the ordinary write path: pinned, audited and deployed.
  const applied = await applyConfigChange(context, subject, input.supply, []);
  if (!applied.ok) return applied;

  // Committed last, so a refusal above leaves the placement where it was. The old
  // pair's desired row stays, serving until `unplaceComponent` retires it.
  const now = context.clock.now();
  await context.db.transaction(async (tx) => {
    await tx
      .insert(componentTargetDesired)
      .values({
        componentId: input.componentId,
        targetId: input.targetId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          componentTargetDesired.componentId,
          componentTargetDesired.targetId,
        ],
        set: { updatedAt: now },
      });
    await tx
      .update(components)
      .set({ placedTargetId: input.targetId, updatedAt: now })
      .where(eq(components.id, input.componentId));
  });

  return ok({
    ...applied.value,
    written: [...new Set([...carried, ...applied.value.written])].sort(),
    carriedFrom: migration.fromTargetId,
    carried,
  });
};
