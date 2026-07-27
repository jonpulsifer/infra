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
import { z } from 'zod';
import type { Command } from '../types.ts';
import {
  type CreateDeployResult,
  checkDeployable,
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

  // The "is this actually older" question is asked **under the lock**, against
  // the desired row as it is at the moment the intent is written. Asking it
  // beforehand would let a concurrent deploy change the answer in the gap, and
  // the gap is exactly when a rollback happens — during an incident, with
  // somebody else also pressing buttons.
  return placeIntent(context, checked.value, (desiredBuildId) => {
    if (desiredBuildId === null) {
      return 'nothing has been deployed here yet, so there is nothing to roll back to';
    }
    if (input.buildId >= desiredBuildId) {
      return `Build ${input.buildId} is not older than the Build that is desired here (${desiredBuildId}) — deploy it forward instead`;
    }
    return null;
  });
};
