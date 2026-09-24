/**
 * Deletes one Component and what only it owns, reviewed before `confirm` like
 * `deleteApp`. A refused teardown is reported, not fatal.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  configItems,
  deploys,
  targets,
  vessels,
} from '../../db/schema.ts';
import { STRANDABLE_PHASES, targetLabel } from '../../domain/target.ts';
import { dnsHandleFor } from '../../domain/workload-name.ts';
import {
  reapableScopes,
  type StrandedWorkload,
  teardown,
} from '../apps/delete.ts';
import { reapKey } from '../config/set.ts';
import { type Command, failed, ok } from '../types.ts';

export const deleteComponentInput = z
  .object({
    componentId: z.uuid(),
    /** False, the default, reviews and deletes nothing. */
    confirm: z.boolean().default(false),
  })
  .strict();

export type DeleteComponentInput = z.infer<typeof deleteComponentInput>;

export interface DeleteComponentEffects {
  readonly componentId: string;
  readonly component: string;
  readonly builds: number;
  readonly deploys: number;
  /** Live placements, torn down on confirm. */
  readonly stranded: readonly StrandedWorkload[];
  /** Config keys whose store items this reaps. */
  readonly configKeys: readonly string[];
}

export type DeleteComponentResult =
  | ({ readonly deleted: false } & DeleteComponentEffects)
  | ({
      readonly deleted: true;
      /** Store items that could not be destroyed. */
      readonly retainedSecrets: readonly string[];
      /** Workloads whose teardown was refused, as `<target> — <why>`. */
      readonly retainedWorkloads: readonly string[];
    } & DeleteComponentEffects);

export const deleteComponent: Command<
  DeleteComponentInput,
  DeleteComponentResult
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

  const [app] = await context.db
    .select({ name: apps.name })
    .from(apps)
    .where(eq(apps.id, component.appId));

  const ownBuilds = await context.db
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.componentId, component.id));

  const ownDeploys = await context.db
    .select({ id: deploys.id })
    .from(deploys)
    .where(eq(deploys.componentId, component.id));

  // Read before the write, because these rows stop being observable after it.
  // Whole Target and vessel rows, because the teardown is addressed with them.
  const live = await context.db
    .select({
      deployId: deploys.id,
      componentId: deploys.componentId,
      targetId: deploys.targetId,
      phase: deploys.phase,
      ref: deploys.ref,
      url: deploys.url,
      target: targets,
      vessel: vessels,
    })
    .from(deploys)
    .innerJoin(targets, eq(deploys.targetId, targets.id))
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(
      and(eq(deploys.componentId, component.id), isNull(deploys.orphanedAt)),
    )
    .orderBy(desc(deploys.id));

  // The review names the phases in which something is up and answering.
  const strandable = live.filter((deploy) =>
    STRANDABLE_PHASES.some((phase) => phase === deploy.phase),
  );

  // The teardown addresses the newest non-orphaned Deploy per Target that has a ref.
  const addresses = new Map<string, (typeof live)[number]>();
  for (const deploy of live) {
    if (deploy.ref === null) continue;
    if (!addresses.has(deploy.targetId)) addresses.set(deploy.targetId, deploy);
  }

  const pinned = await context.db
    .select({
      componentId: configItems.componentId,
      targetId: configItems.targetId,
      key: configItems.key,
    })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, component.id),
        inArray(configItems.kind, ['secret_ref', 'build_secret']),
      ),
    );

  const effects: DeleteComponentEffects = {
    componentId: component.id,
    component: component.name,
    builds: ownBuilds.length,
    deploys: ownDeploys.length,
    stranded: strandable.map((deploy) => ({
      deployId: String(deploy.deployId),
      component: component.name,
      target: targetLabel({
        vessel: deploy.vessel.name,
        adapter: deploy.target.adapter,
      }),
      url: deploy.url,
      firing: component.kind === 'job' && component.schedule !== null,
      nameSpent: deploy.target.adapter === 'static',
    })),
    configKeys: pinned.map((item) => item.key),
  };

  if (!input.confirm) {
    return ok({ deleted: false, ...effects });
  }

  // Resolved before the rows go, used after.
  const scopes = await reapableScopes(
    context,
    pinned,
    new Map([[component.id, component.name]]),
  );

  // Torn down before the row goes, so a crash in between leaves a retryable
  // delete instead of an orphan nothing names.
  const retainedWorkloads: string[] = [];
  for (const deploy of addresses.values()) {
    const refusal = await teardown(context, deploy);
    const target = targetLabel({
      vessel: deploy.vessel.name,
      adapter: deploy.target.adapter,
    });
    if (refusal !== null) {
      retainedWorkloads.push(`${target} — ${refusal}`);
      continue;
    }
    // Withdraw the vanity record. Idempotent and best effort.
    try {
      await context.adapters
        .dns?.()
        ?.withdraw(dnsHandleFor(app!.name, component.name));
    } catch {
      // Converges the next time this handle is published or withdrawn.
    }
  }

  // Deleted in order, not by cascade: `deploys.build_id` and the desired row's
  // links are `restrict`, which Postgres enforces even within one cascade.
  await context.db.transaction(async (tx) => {
    await tx
      .delete(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, component.id));
    await tx.delete(deploys).where(eq(deploys.componentId, component.id));
    await tx.delete(builds).where(eq(builds.componentId, component.id));
    await tx.delete(components).where(eq(components.id, component.id));
  });

  const retainedSecrets: string[] = [];
  for (const scope of scopes) {
    for (const key of scope.keys) {
      if (scope.subject === null) {
        retainedSecrets.push(key);
        continue;
      }
      try {
        // Retention zero: nothing is left to roll back to.
        await reapKey(scope.subject, key, 0);
      } catch {
        retainedSecrets.push(key);
      }
    }
  }

  return ok({ deleted: true, retainedSecrets, retainedWorkloads, ...effects });
};
