/**
 * `rollbackDeploy` is an ordinary deploy of an older Build, with the checks and
 * lock `createDeploy` uses. It refuses a Build that is not older, and locks the
 * App in the same transaction so the next push does not undo it.
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

export type RollbackDeployResult = CreateDeployResult;

export const rollbackDeploy: Command<
  RollbackDeployInput,
  RollbackDeployResult
> = async (input, context) => {
  const checked = await checkDeployable(input, context, { bypassLock: true });
  if (!checked.ok) return { ok: false, failure: checked.failure };

  // Restore how this Build last ran here, config included. A Build never
  // deployed here uses the current Component.
  const previous = await lastDeployOf(context, input);
  const value =
    previous === null
      ? checked.value
      : deliveringRelease(checked.value, previous);

  // Asked under the lock, against the desired row as it is now. The hold rides
  // the same transaction, so a refused rollback locks nothing.
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
 * What the newest Deploy of this Build on this Target delivered, if any. The
 * version is recomputed from the document, not read from `config_version`.
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
