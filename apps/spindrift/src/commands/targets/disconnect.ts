/**
 * `disconnectTarget`: live Deploys become orphaned and keep running. It never
 * calls the adapter, so a disconnect never destroys a workload.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  isDeclaredInstallationVessel,
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
    vessel: z.string().trim().min(1),
    adapter: targetAdapterSchema,
    /** False previews the Deploys a confirm would orphan; absent confirms. */
    confirm: z.boolean().optional(),
  })
  .strict();

export type DisconnectTargetInput = z.infer<typeof disconnectTargetInput>;

export interface StrandedDeploy {
  readonly deployId: string;
  readonly app: string;
  readonly component: string;
  /** `null` when the Target gave it no address. */
  readonly url: string | null;
}

export interface DisconnectTargetResult {
  readonly targetId: string;
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  readonly disconnected: boolean;
  readonly stranded: readonly StrandedDeploy[];
}

export const disconnectTarget: Command<
  DisconnectTargetInput,
  DisconnectTargetResult
> = async (input, context) => {
  const now = context.clock.now();
  const confirmed = input.confirm ?? true;

  // The manifest names the home and control-plane vessels without a foreign
  // key, so this guard protects them. It runs before the preview as well.
  if (isDeclaredInstallationVessel(context.manifest, input.vessel)) {
    return failed(
      'NOT_DEPLOYABLE',
      `${input.vessel} is a vessel this installation is built on, so its surfaces cannot be disconnected — change the declaration and re-seed instead`,
    );
  }

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

  // Read before orphaning: afterwards the `orphanedAt` filter would match none.
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
