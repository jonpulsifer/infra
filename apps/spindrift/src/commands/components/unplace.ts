/**
 * `unplaceComponent` — stop a specific (Component, Target) placement (75, §6,
 * §13).
 *
 * Two things left a Component's old address firing after it moved: nothing
 * called `DeployAdapter.destroy` when a Target changed, and nothing called it
 * when a `job` became a `service` and the ref that used to answer for it
 * became an orphan under `jobs/<id>`. Both are the same gap — a caller for a
 * verb every adapter already implements — and this is that caller.
 *
 * **This is the deliberate exception to §13's rule, not a violation of it.**
 * `disconnectTarget` and `deleteApp` both refuse to call the adapter, and both
 * say why in the same words: tearing down a running workload is not what
 * "disconnect this Target" or "delete this record" asked for, and doing it as
 * an automatic side effect of a record-level act would be the most destructive
 * possible reading of a request that did not ask for one. Neither of those
 * commands' subject is "stop this placement" — their subject is the Target row
 * or the App row, and the workload is collateral they are careful not to touch.
 * This command's *entire subject* is the placement itself. An operator who
 * calls `unplaceComponent` is not tidying bookkeeping and getting a surprise
 * teardown; the teardown is the thing they asked for by name. §13's rule is
 * "never destroy as a side effect of something else"; this is not a side
 * effect.
 *
 * **Idempotent in the two ways that matter.** `DeployAdapter.destroy` is
 * contracted to succeed against a ref the platform has already removed — this
 * command relies on exactly that rather than re-deriving it. And a pair with
 * no live ref at all (never successfully deployed, or already unplaced by an
 * adapter call that ran and then failed to write back) costs no adapter call:
 * there is nothing to destroy, so nothing is asked to. Calling this command a
 * second time on a pair it already retracted is answered with `NOT_FOUND` —
 * there is no longer a placement to stop, which is the honest reading of "do
 * it again" once the first call deleted the row that named it.
 *
 * **A destroy the platform refuses leaves everything as it was.** The adapter
 * call happens before any row is touched, so a thrown error returns a failure
 * with nothing to unwind: the placement is still there, the old Deploy is
 * still live, and pressing the button again is the retry.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  components,
  componentTargetDesired,
  deploys,
  targets,
  vessels,
} from '../../db/schema.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
} from '../../domain/target.ts';
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
  /**
   * Whether a live ref was found and handed to `destroy`.
   *
   * `false` means the placement was retracted with no adapter call — it had
   * never produced a ref, or every Deploy that had one was already orphaned.
   * Either way the row this command exists to remove is gone.
   */
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

  const [target] = await context.db
    .select()
    .from(targets)
    .where(eq(targets.id, input.targetId));
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
      `'${component.name}' is not placed on '${target.name}'`,
    );
  }

  // The newest Deploy for this pair that still names a live ref — `ref`
  // persists through a failed re-attempt (`settle`, `deploy-loop.ts`), so the
  // newest row that ever recorded one is the workload's current address,
  // whatever that row's own terminal phase now says. Already-orphaned rows are
  // excluded: `disconnectTarget` or an earlier `unplaceComponent` already
  // decided this pair's platform-side story, and re-destroying a ref this
  // command no longer owns would be exactly the "our side, not the far side"
  // fake §Testing warns against, aimed at production.
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
        `'${target.name}' is not connected, so nothing can be torn down there`,
      );
    }
    const adapter = context.adapters.deploy(target.adapter);
    if (adapter === null) {
      return failed(
        'NOT_REMOVABLE',
        `this installation has no ${target.adapter} adapter`,
      );
    }
    // §6 contracts `apply` not to throw; it says nothing of the kind about
    // `destroy`, because a fault tearing something down is the far side's to
    // report honestly rather than core's to paper over. Caught here, before
    // any row is touched, so a refusal leaves the placement exactly as
    // findable as it was for a retry.
    try {
      await adapter.destroy(deployTargetOf(target, live.vessel), ref);
    } catch (cause) {
      return failed(
        'NOT_REMOVABLE',
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  }

  const now = context.clock.now();
  await context.db.transaction(async (tx) => {
    // Same ordering `deleteApp` uses and the same reason: nothing else
    // references this row, so it goes first and cleanly, while the Deploys it
    // pointed at stay as history.
    await tx
      .delete(componentTargetDesired)
      .where(eq(componentTargetDesired.id, desired.id));
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
