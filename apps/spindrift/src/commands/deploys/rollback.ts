/**
 * `rollbackDeploy` — go back to an older Build (§6).
 *
 * §6: "**Rollback is an ordinary deploy** — a newer intent row pointing at an
 * older Build — so no adapter has a special path."
 *
 * This command is therefore almost entirely a name. It runs the same
 * preconditions and takes the same lock as `createDeploy`, because a rollback
 * that checked less would be a way to place a Build that an ordinary deploy had
 * refused. What it adds is one check the forward direction does not want: that
 * the Build named really is **older** than what is desired now.
 *
 * That check is not ceremony. `Build.id` is a `bigserial` precisely so it carries
 * a total order (§6: "its id IS the total order"), and a "rollback" to a *newer*
 * Build is a roll-forward that a developer typed the wrong word for. Refusing it
 * costs one sentence and saves the case where someone reaches for rollback during
 * an incident and silently ships something newer instead.
 *
 * **A rollback dispatches no build.** Structurally, not by convention: the whole
 * point of one Build to many Deploys (§2) is that the artifact already exists, and
 * nothing on this path looks up a build adapter to run one with.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { deploys } from '../../db/schema.ts';
import { configVersionOf } from '../../domain/config-version.ts';
import type { PinnedConfig } from '../config/pinned.ts';
import type { Command, CommandContext } from '../types.ts';
import {
  type CreateDeployResult,
  checkDeployable,
  deliveringConfig,
  placeIntent,
} from './create.ts';

export const rollbackDeployInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /** The older Build to make live again. */
    buildId: z.number().int().positive(),
  })
  .strict();

export type RollbackDeployInput = z.infer<typeof rollbackDeployInput>;

/** The same result an ordinary deploy returns, because that is what this is. */
export type RollbackDeployResult = CreateDeployResult;

export const rollbackDeploy: Command<
  RollbackDeployInput,
  RollbackDeployResult
> = async (input, context) => {
  const checked = await checkDeployable(input, context);
  if (!checked.ok) return { ok: false, failure: checked.failure };

  // §10: "a rollback comes back up with the configuration it originally had."
  // The pin is what makes that possible and the *document* is what makes it
  // happen: the ordinary path captures config as it is now, which for a
  // rollback would be the config of the release being rolled *away from*. So
  // the last Deploy of this Build here is asked what it delivered, and this
  // intent delivers that.
  //
  // A Build that has never been deployed to this Target has nothing to say, and
  // then current config is the only honest answer — the alternative is coming
  // up unconfigured because history is silent.
  const previous = await lastDeployOf(context, input);
  const value =
    previous === null
      ? checked.value
      : deliveringConfig(checked.value, previous);

  // The "is this actually older" question is asked **under the lock**, against
  // the desired row as it is at the moment the intent is written. Asking it
  // beforehand would let a concurrent deploy change the answer in the gap, and
  // the gap is exactly when a rollback happens — during an incident, with
  // somebody else also pressing buttons.
  return placeIntent(context, value, (desiredBuildId) => {
    if (desiredBuildId === null) {
      return 'nothing has been deployed here yet, so there is nothing to roll back to';
    }
    if (input.buildId >= desiredBuildId) {
      return `Build ${input.buildId} is not older than the Build that is desired here (${desiredBuildId}) — deploy it forward instead`;
    }
    return null;
  });
};

/**
 * What the newest Deploy of this Build on this Target delivered, if any.
 *
 * Newest rather than oldest: a Build deployed, reconfigured, and deployed again
 * was last seen serving the second configuration, and that is the release a
 * developer means when they say roll back to it.
 *
 * The version is recomputed rather than read from `config_version`, so a row
 * whose two columns ever disagreed cannot deliver a document under a hash that
 * does not describe it.
 */
async function lastDeployOf(
  context: CommandContext,
  input: RollbackDeployInput,
): Promise<PinnedConfig | null> {
  const [previous] = await context.db
    .select({ desired: deploys.desired })
    .from(deploys)
    .where(
      and(
        eq(deploys.componentId, input.componentId),
        eq(deploys.targetId, input.targetId),
        eq(deploys.buildId, input.buildId),
      ),
    )
    .orderBy(desc(deploys.id))
    .limit(1);

  if (previous === undefined) return null;
  return {
    document: previous.desired.config,
    version: await configVersionOf(previous.desired.config),
  };
}
