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
 *
 * **A rollback locks the App, in the same transaction as its intent.** It is
 * the one intent that goes through a lock, and the one that sets it: without
 * the lock, the next adopted push — a Renovate merge at 03:00 — goes straight
 * back out through `dispatchAutoDeploys`, and there is no step anywhere where
 * the operator says the cause is fixed. `setAppLock` with `reason: null` is
 * that step. One transaction rather than two statements, because the hold is
 * what makes the rollback stick: a forward intent whose checks passed a moment
 * earlier serializes behind this one on the desired row and then reads the
 * App's lock — so it must already be there when this commits. The reason
 * names what was asked for, what it superseded and who asked, in words that
 * stay true if the Deploy itself later fails: requested, not done.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { deploys } from '../../db/schema.ts';
import { configVersionOf } from '../../domain/config-version.ts';
import type { DesiredDocument } from '../../domain/desired-state.ts';
import { lockApp } from '../apps/set-lock.ts';
import type { Command, CommandContext } from '../types.ts';
import {
  type CreateDeployResult,
  checkDeployable,
  deliveringRelease,
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
  const checked = await checkDeployable(input, context, { bypassLock: true });
  if (!checked.ok) return { ok: false, failure: checked.failure };

  // §10: "a rollback comes back up with the configuration it originally had."
  // The pin is what makes that possible and the *document* is what makes it
  // happen: the ordinary path captures the release as it is now, which for a
  // rollback would be the release being rolled *away from*. So the last Deploy
  // of this Build here is asked what it delivered, and this intent delivers
  // that.
  //
  // Which parts of it, and why, is `DesiredDocument`'s to say — the rule is
  // that a rollback restores how the artifact ran and not where it answered,
  // and `deliveringRelease` is where that is applied. It lives there rather
  // than here so this file and the column cannot drift apart again.
  //
  // A Build that has never been deployed to this Target has nothing to say, and
  // then the current Component is the only honest answer — the alternative is
  // coming up unconfigured because history is silent.
  const previous = await lastDeployOf(context, input);
  const value =
    previous === null
      ? checked.value
      : deliveringRelease(checked.value, previous);

  // The "is this actually older" question is asked **under the lock**, against
  // the desired row as it is at the moment the intent is written. Asking it
  // beforehand would let a concurrent deploy change the answer in the gap, and
  // the gap is exactly when a rollback happens — during an incident, with
  // somebody else also pressing buttons.
  //
  // The hold rides the same transaction (`onPlaced`): the superseded Build it
  // names is the one that locking read returned, and a refused rollback never
  // reaches it, so a refusal locks nothing.
  return placeIntent(
    context,
    value,
    (desiredBuildId) => {
      if (desiredBuildId === null) {
        return 'nothing has been deployed here yet, so there is nothing to roll back to';
      }
      if (input.buildId >= desiredBuildId) {
        return `Build ${input.buildId} is not older than the Build that is desired here (${desiredBuildId}) — deploy it forward instead`;
      }
      return null;
    },
    (tx, placed) =>
      lockApp(
        tx,
        placed.appId,
        `rollback to Build ${input.buildId} requested, superseding Build ${placed.supersededBuildId}, by ${context.principal.displayName}; unlock once the cause is fixed`,
        context.principal,
        context.clock.now(),
      ),
  );
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
): Promise<{
  readonly desired: DesiredDocument;
  readonly configVersion: string;
} | null> {
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
    desired: previous.desired,
    configVersion: await configVersionOf(previous.desired.config),
  };
}
