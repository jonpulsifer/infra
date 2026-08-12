/**
 * `placeComponent` — commit a Component's move to a Target (§3, §10).
 *
 * Placement itself is a filter and a query (`resolveComponentPlacement`, §3):
 * nothing is written by asking where a Component *can* go. This is the act that
 * follows it, and it exists because of one line in §10: "**Place names the keys
 * that will not follow and demands them before the move commits.**"
 *
 * So the whole command is that sentence:
 *
 * 1. Work out what moving does to configuration (`migrationFor`).
 * 2. Carry the pinned references that can be carried — the same store of record
 *    on both sides makes a re-placement free, and free means the reference
 *    moves while no value does.
 * 3. **Refuse, naming the keys**, when something cannot be carried and was not
 *    supplied. Not a warning: §10 wants "a re-placement never comes up green and
 *    unconfigured", and a warning is a thing that gets clicked through.
 * 4. **Write the placement.** The desired row for (Component, Target) is what
 *    `deployApp` reads as where this Component now lives, so a move that wrote
 *    no row was a move nothing could see: the next deploy still resolved the
 *    old Target, refused the new one as "placed elsewhere — move it first",
 *    and pointed back at the command that had already run. The old pair's row
 *    stays — what is live there keeps serving until `unplaceComponent`
 *    retires it.
 *
 * `createDeploy` refuses on the same condition, because a developer who skipped
 * Place and deployed straight at the new Target would otherwise get exactly the
 * green-and-unconfigured release this command exists to prevent.
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
    /**
     * Values for the keys that will not follow, supplied as part of the move.
     *
     * Part of *this* act rather than a separate call the caller is trusted to
     * make first: "demands them before the move commits" is only true if the
     * move and the supply are one transaction from the developer's side.
     */
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
  /** The Target the configuration was carried from, if any. */
  readonly carriedFrom: string | null;
  /** Keys whose pinned references moved as they were — no value crossed. */
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
    // The keys structurally as well as in the sentence. A caller that has to
    // *collect* them — the workspace's move form, which re-posts this same
    // command with `supply` filled in — would otherwise have to parse them back
    // out of prose written for a person, and the field they belong against is
    // what `issues` says: `connectTarget` already refuses this way
    // (`targets/connect.ts:318-328`). The sentence is unchanged; this is the
    // same refusal addressed to the form as well as to the reader.
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

  // The supplied values go through the ordinary write path, so a key demanded
  // by a move is pinned, audited, and deployed exactly like one a developer
  // typed into the config screen. A second path here would be a second way for
  // a value to reach the store.
  const applied = await applyConfigChange(context, subject, input.supply, []);
  if (!applied.ok) return applied;

  // The move itself, committed last so a refusal above leaves the placement
  // where it was. Two writes in one transaction: the pair's desired row, which
  // is what the loops act on, and `placedTargetId`, the placement of record —
  // this command is the only one that *moves* it. The old pair's desired row
  // stays: what is live there keeps serving until `unplaceComponent` retires
  // it.
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
