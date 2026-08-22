/**
 * `deleteComponent` — remove one Component and everything that is only ever
 * its own (§2, §9, §13).
 *
 * §9's sole-serving rule (`soleServingComponent`, `deploy-loop.ts`) counts
 * every Component an App has, live or not — an App whose demo Component died
 * months ago beside the one that actually serves traffic never gets its
 * vanity name, because two rows still contend for one App-level name. There
 * was no way to remove the dead one; this is that way.
 *
 * **The same shape `deleteApp` already proved**, over one Component instead
 * of every Component an App has: review-then-confirm, the live placements it
 * would tear down named before anything happens, a teardown the platform
 * refuses reported rather than failing the delete, and the config store
 * reaped after the rows that named the pins are gone. `teardown` and
 * `reapableScopes` are `deleteApp`'s own — this reuses them rather than
 * assembling a second copy of reasoning that has to keep agreeing with the
 * first.
 *
 * **What is genuinely different is small.** One Component's own
 * `builds`/`deploys`/`component_target_desired` rows are `restrict`-linked to
 * each other the identical way an App's every Component's are (`deleteApp`'s
 * header explains why the order matters), so the delete still clears them by
 * hand before the row itself goes — but there is exactly one `components` row
 * to remove here, not a whole App's worth, and nothing here touches
 * Datastores: §11 attaches those to the App, never to a Component, so a
 * Component's own deletion has nothing of theirs to detach.
 *
 * **An App with no Components left is a valid state, not a refusal this
 * command has to guard against.** It has no placement, and its address shows
 * the status page (§9) — the same as an App that never placed anything.
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
    /** False — the default — reviews and deletes nothing. */
    confirm: z.boolean().default(false),
  })
  .strict();

export type DeleteComponentInput = z.infer<typeof deleteComponentInput>;

/** What deleting this Component does, whether or not it has been done yet. */
export interface DeleteComponentEffects {
  readonly componentId: string;
  readonly component: string;
  readonly builds: number;
  readonly deploys: number;
  /** Live placements, torn down on confirm — the point of the confirmation. */
  readonly stranded: readonly StrandedWorkload[];
  /** §10 config keys, as `KEY`, whose store items this reaps. */
  readonly configKeys: readonly string[];
}

export type DeleteComponentResult =
  | ({ readonly deleted: false } & DeleteComponentEffects)
  | ({
      readonly deleted: true;
      /** Store items that outlived their rows because the store refused to
       * destroy them. Empty is the ordinary answer. */
      readonly retainedSecrets: readonly string[];
      /**
       * Workloads that outlived their rows because the teardown was refused —
       * `<target> — <why>`. Empty is the ordinary answer.
       */
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

  // Read before write, for the same reason `deleteApp` does: the rows to name
  // are exactly the rows about to stop being observable. Whole Target and
  // vessel rows, because what is read here is also what the teardown is
  // addressed with.
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

  // What the review names: the phases in which something is actually up there
  // answering (§13's grammar) — `deleteApp`'s own rule, unchanged here.
  const strandable = live.filter((deploy) =>
    STRANDABLE_PHASES.some((phase) => phase === deploy.phase),
  );

  // What the teardown addresses, which is not the same list — the newest
  // non-orphaned Deploy per Target that carries a `ref` at all, exactly the
  // rule `deleteApp` and `unplaceComponent` both read it by.
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

  // Resolved before the rows go, used after they have — `deleteApp`'s own
  // helper, over the one Component this delete is about.
  const scopes = await reapableScopes(
    context,
    pinned,
    new Map([[component.id, component.name]]),
  );

  // Torn down before the row goes, so a crash between the two leaves a
  // retryable delete rather than an orphan nothing names any more.
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
    // §9: withdraw whatever vanity record this placement earned. Idempotent
    // and best-effort — the same reasoning `deleteApp` and `unplaceComponent`
    // both state.
    try {
      await context.adapters
        .dns?.()
        ?.withdraw(dnsHandleFor(app!.name, component.name));
    } catch {
      // Left to converge next time something else publishes or withdraws
      // this handle.
    }
  }

  // Ordered rather than left to the cascade — `deleteApp`'s own reasoning,
  // over one Component's rows instead of every Component an App has:
  // `deploys.build_id` and `component_target_desired.desired_*` are
  // `restrict`, and Postgres enforces one the moment its referenced row is
  // deleted, including when the referencing row is being deleted by the same
  // cascade. `config_items`, `config_audit_events` and `attempt_events` still
  // cascade off the Component.
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
        // Retention zero: every version, not the tail past the depth §10
        // keeps for a rollback. There is nothing left to roll back to.
        await reapKey(scope.subject, key, 0);
      } catch {
        retainedSecrets.push(key);
      }
    }
  }

  return ok({ deleted: true, retainedSecrets, retainedWorkloads, ...effects });
};
