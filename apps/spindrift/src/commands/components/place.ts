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
 *
 * `createDeploy` refuses on the same condition, because a developer who skipped
 * Place and deployed straight at the new Target would otherwise get exactly the
 * green-and-unconfigured release this command exists to prevent.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { targets } from '../../db/schema.ts';
import { VARIABLE_NAME } from '../../domain/config.ts';
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
      .select({ name: targets.name })
      .from(targets)
      .where(eq(targets.id, input.targetId));
    return failed(
      'NOT_DEPLOYABLE',
      demandSentence(missing, target?.name ?? input.targetId),
    );
  }

  const carried = await carryReferences(context, subject, migration.follows);

  // The supplied values go through the ordinary write path, so a key demanded
  // by a move is pinned, audited, and deployed exactly like one a developer
  // typed into the config screen. A second path here would be a second way for
  // a value to reach the store.
  const applied = await applyConfigChange(context, subject, input.supply, []);
  if (!applied.ok) return applied;

  return ok({
    ...applied.value,
    written: [...new Set([...carried, ...applied.value.written])].sort(),
    carriedFrom: migration.fromTargetId,
    carried,
  });
};
