/**
 * `disconnectTarget` (§13).
 *
 * "**Disconnect always works**: live Deploys go `orphaned`, workloads keep
 * running, reconnect re-adopts via `observe`, and the confirmation names what it
 * strands."
 *
 * Every clause of that is a refusal to do something an operator might expect.
 * This command **never calls the adapter** — not to check reachability, and
 * emphatically not to `destroy`. Disconnecting a Target is a statement about
 * Spindrift's relationship to it, not about the workloads on it: a cluster being
 * removed from the platform is exactly when tearing down what is running on it
 * would be the most destructive possible reading of the request.
 *
 * What the operator gets instead is the list. §13 asks the confirmation to name
 * what it strands, so the result is the stranded Deploys with the App and
 * Component each belongs to — enough to go and clean them up by hand, which is
 * the only thing that can clean them up now.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { apps, components, deploys, targets } from '../../db/schema.ts';
import { STRANDABLE_PHASES } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const disconnectTargetInput = z
  .object({
    /** Targets are addressed by name; the id is core's, not the operator's. */
    name: z.string().trim().min(1),
  })
  .strict();

export type DisconnectTargetInput = z.infer<typeof disconnectTargetInput>;

/** One workload that keeps running with nothing managing it. */
export interface StrandedDeploy {
  readonly deployId: string;
  readonly app: string;
  readonly component: string;
  /** Where it is still answering, where the Target gave it an address. */
  readonly url: string | null;
}

export interface DisconnectTargetResult {
  readonly targetId: string;
  readonly name: string;
  /** Named, per §13 — this list is the whole point of the confirmation. */
  readonly stranded: readonly StrandedDeploy[];
}

export const disconnectTarget: Command<
  DisconnectTargetInput,
  DisconnectTargetResult
> = async (input, context) => {
  const now = context.clock.now();

  const target = (
    await context.db.select().from(targets).where(eq(targets.name, input.name))
  )[0];
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no Target named ${input.name}`);
  }

  // Read before write: the rows to name in the confirmation are exactly the
  // rows about to be stranded, and reading them afterwards would return them
  // already orphaned with no way to tell which this act orphaned.
  const strandable = await context.db
    .select({
      deployId: deploys.id,
      url: deploys.url,
      app: apps.name,
      component: components.name,
    })
    .from(deploys)
    .innerJoin(components, eq(deploys.componentId, components.id))
    .innerJoin(apps, eq(components.appId, apps.id))
    .where(
      and(
        eq(deploys.targetId, target.id),
        isNull(deploys.orphanedAt),
        inArray(deploys.phase, [...STRANDABLE_PHASES]),
      ),
    );

  if (strandable.length > 0) {
    await context.db
      .update(deploys)
      .set({ orphanedAt: now, updatedAt: now })
      .where(
        inArray(
          deploys.id,
          strandable.map((deploy) => deploy.deployId),
        ),
      );
  }

  await context.db
    .update(targets)
    .set({ status: 'disconnected', updatedAt: now })
    .where(eq(targets.id, target.id));

  return ok({
    targetId: target.id,
    name: target.name,
    stranded: strandable.map((deploy) => ({
      deployId: String(deploy.deployId),
      app: deploy.app,
      component: deploy.component,
      url: deploy.url,
    })),
  });
};
