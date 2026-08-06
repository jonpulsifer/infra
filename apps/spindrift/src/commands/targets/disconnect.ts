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
 * What the operator gets first is the list. `confirm: false` performs the same
 * read without the write so the UI can name the impact in place; confirmation
 * returns the stranded Deploys with the App and Component each belongs to.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  type TargetAdapter,
  targetAdapterSchema,
} from '../../config/manifest.schema.ts';
import {
  apps,
  components,
  deploys,
  targets,
  vessels,
} from '../../db/schema.ts';
import { STRANDABLE_PHASES, targetLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const disconnectTargetInput = z
  .object({
    /**
     * The Target, as the two facts that identify it: the boundary it is a
     * surface on and the runtime it is. The id is core's, not the operator's.
     */
    vessel: z.string().trim().min(1),
    adapter: targetAdapterSchema,
    /** False previews the Deploys that confirmation would orphan. */
    confirm: z.boolean().optional(),
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
  /** The boundary it is a surface on — the two together are what name it. */
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  /** False for an impact review; true once the Target was disconnected. */
  readonly disconnected: boolean;
  /** Named, per §13 — this list is the whole point of the confirmation. */
  readonly stranded: readonly StrandedDeploy[];
}

export const disconnectTarget: Command<
  DisconnectTargetInput,
  DisconnectTargetResult
> = async (input, context) => {
  const now = context.clock.now();
  const confirmed = input.confirm ?? true;

  // The pair, not a name: `(vessel, adapter)` is what a Target is, and it is the
  // unique index too, so this resolves at most one row.
  const target = (
    await context.db
      .select({ id: targets.id })
      .from(targets)
      .innerJoin(vessels, eq(targets.vesselId, vessels.id))
      .where(
        and(eq(vessels.name, input.vessel), eq(targets.adapter, input.adapter)),
      )
  )[0];
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no ${targetLabel(input)} Target`);
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

  if (confirmed && strandable.length > 0) {
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

  if (confirmed) {
    await context.db
      .update(targets)
      .set({ status: 'disconnected', updatedAt: now })
      .where(eq(targets.id, target.id));
  }

  return ok({
    targetId: target.id,
    vessel: input.vessel,
    adapter: input.adapter,
    disconnected: confirmed,
    stranded: strandable.map((deploy) => ({
      deployId: String(deploy.deployId),
      app: deploy.app,
      component: deploy.component,
      url: deploy.url,
    })),
  });
};
