/**
 * `deleteApp` — remove an App and everything that is only ever its own (§2).
 *
 * §2 already settles what deletion means: it "detaches its Datastores and never
 * cascades to them (§2, §11) but does cascade to its own Components, Builds,
 * Deploys, and config items — none of those are reattachable." So the shape of
 * this command is not a question about the model. What is a question is the two
 * things a delete can do that nobody asked for, and both are answered the same
 * way — by saying so first.
 *
 * **It is review-then-confirm, like `replaceConfig`.** The first call writes
 * nothing and returns what the delete would do: the Components that go, the
 * Datastores that survive detached, and — the half that matters — the live
 * workloads it tears down. The second call, with `confirm`, does it. An act
 * that removes a Component's whole build and deploy history on the first call is
 * one nobody can look at before it happens, which is the same argument §10 makes
 * about a bulk paste.
 *
 * **It tears the workloads down**, and that is `unplaceComponent`'s exception to
 * §13 rather than a violation of it: §13's rule is "never destroy as a side
 * effect of *something else*", and an operator who confirms a delete having just
 * been shown the running workloads by name has asked for those workloads to go.
 * The alternative is a `kind: job` Component with a `schedule` firing on every
 * tick, forever, billed in a vessel project nobody is watching, whose only
 * record is a dialog somebody has to act on by hand. So the review names every
 * live workload before anything happens, and each entry says whether it keeps
 * *acting* (`StrandedWorkload.firing`) and whether tearing it down spends its
 * address for good (`StrandedWorkload.nameSpent`, true on static hosting) —
 * those sentences are what the confirmation is for.
 *
 * **What it tears down is not what it names.** The review names the phases in
 * which something is up there answering; the teardown addresses the newest
 * non-orphaned Deploy per placement that carries a `ref` at all, which is
 * `unplaceComponent`'s rule and the reason a FAILED Deploy's half-made resource
 * is not left behind billing.
 *
 * **A teardown the platform refuses does not fail the delete.** Same argument as
 * `retainedSecrets` below: the operator asked for the App to be gone, an
 * unreachable Target is not a reason to keep the rows, and `destroy` is
 * contracted idempotent so nothing is lost by having tried. Those workloads are
 * named in `retainedWorkloads` — genuinely stranded, and now the short list of
 * what is left to do by hand rather than all of it.
 *
 * **It does reap the config store**, and that is not the same thing. §10's
 * store items are per-key material this App put there and nothing else will ever
 * read — a pin whose row is gone is unreachable, not merely unmanaged — so
 * leaving them is a leak rather than a workload. A key the store refuses to
 * destroy is named in `retainedSecrets` rather than failing the delete: the rows
 * are already gone by then, and a refusal at that point would report a delete
 * that happened as one that did not.
 */
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  configItems,
  datastores,
  deploys,
  targets,
  vessels,
} from '../../db/schema.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  STRANDABLE_PHASES,
  type TargetConnection,
  targetLabel,
} from '../../domain/target.ts';
import type { VesselLocation } from '../../domain/vessel.ts';
import { dnsHandleFor } from '../../domain/workload-name.ts';
import { type ConfigSubject, configSubject, reapKey } from '../config/set.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

export const deleteAppInput = z
  .object({
    /** The App's id, or its name where that names exactly one App. */
    name: z.string().trim().min(1),
    /**
     * False — the default — reviews and deletes nothing.
     *
     * The two calls are independent: the second re-reads the App and recomputes
     * what it is about to tear down, so a deploy that went live between them is
     * torn down and named rather than left behind under a review that said
     * there was nothing running.
     */
    confirm: z.boolean().default(false),
  })
  .strict();

export type DeleteAppInput = z.infer<typeof deleteAppInput>;

/** One live workload — what confirming this delete tears down (§13's grammar). */
export interface StrandedWorkload {
  readonly deployId: string;
  readonly component: string;
  /** Where it is running, and where the teardown is addressed. */
  readonly target: string;
  readonly url: string | null;
  /**
   * Whether this workload keeps *acting* rather than merely sitting.
   *
   * A service left running is inert until something calls it; a `kind: job`
   * Component with a `schedule` has a Cloud Scheduler job in front of it that
   * fires on every tick forever, billed in a vessel project nobody is watching
   * — the cost that makes tearing it down the right default, and the one a
   * refused teardown leaves behind. Derived from the Component, not the Deploy:
   * the cadence lives on `components.schedule`, and it is what fires regardless
   * of which Build is live.
   */
  readonly firing: boolean;
  /**
   * Whether the name this workload holds is spent permanently.
   *
   * Static hosting site ids are global and never given back: "Deleting a site
   * is a permanent action. If you delete a site, Firebase doesn't maintain
   * records of deployed files or deployment history, and the `SITE_ID` cannot
   * be reactivated by you or anyone else." So the teardown this delete performs
   * costs that name for good, and neither this App nor any other can ever
   * deploy under it again. Said in the review rather than after, because it is
   * the one consequence of confirming that undoing the delete does not answer.
   *
   * Derived from the Target's adapter: it is a fact about the platform the
   * workload sits on, not about the Deploy.
   */
  readonly nameSpent: boolean;
}

/** What deleting this App does, whether or not it has been done yet. */
export interface DeleteAppEffects {
  readonly appId: string;
  readonly name: string;
  /** Gone with the App — a Component is not a thing that reattaches (§2). */
  readonly components: readonly string[];
  readonly builds: number;
  readonly deploys: number;
  /** Live workloads, torn down on confirm — the point of the confirmation. */
  readonly stranded: readonly StrandedWorkload[];
  /** §11: these survive, detached. The App owned the attachment, not the data. */
  readonly detachedDatastores: readonly string[];
  /** §10 config keys, as `component/KEY`, whose store items this reaps. */
  readonly configKeys: readonly string[];
}

export type DeleteAppResult =
  | ({ readonly deleted: false } & DeleteAppEffects)
  | ({
      readonly deleted: true;
      /**
       * Store items that outlived their rows because the store refused to
       * destroy them. Empty is the ordinary answer; a non-empty list is
       * material somebody has to remove in the store's own console.
       */
      readonly retainedSecrets: readonly string[];
      /**
       * Workloads that outlived their rows because the teardown was refused —
       * `<component> on <target> — <why>`. Empty is the ordinary answer; a
       * non-empty list is what is genuinely stranded and has to be removed on
       * the Target by hand.
       */
      readonly retainedWorkloads: readonly string[];
    } & DeleteAppEffects);

export const deleteApp: Command<DeleteAppInput, DeleteAppResult> = async (
  input,
  context,
) => {
  // `apps` carries no unique constraint on `name`, so a name is not an
  // identifier — the same reason `deployApp` reads every match rather than
  // `findFirst`. Guessing which of two Apps to deploy is recoverable; guessing
  // which of two to delete is not.
  const isUuid = z.uuid().safeParse(input.name).success;
  const matches = await context.db
    .select()
    .from(apps)
    .where(
      isUuid
        ? or(eq(apps.name, input.name), eq(apps.id, input.name))
        : eq(apps.name, input.name),
    );

  if (matches.length === 0) {
    return failed('NOT_FOUND', `App '${input.name}' not found`);
  }

  if (matches.length > 1) {
    return failed(
      'INVALID_INPUT',
      `${matches.length} Apps answer to '${input.name}', so this would delete an arbitrary one — delete by id: ${matches
        .map((candidate) => candidate.id)
        .join(', ')}`,
      [{ path: 'name', message: 'names more than one App' }],
    );
  }

  const app = matches[0]!;

  const ownComponents = await context.db
    .select({ id: components.id, name: components.name })
    .from(components)
    .where(eq(components.appId, app.id));
  const componentIds = ownComponents.map((component) => component.id);
  const nameOf = new Map(
    ownComponents.map((component) => [component.id, component.name]),
  );

  const ownBuilds =
    componentIds.length === 0
      ? []
      : await context.db
          .select({ id: builds.id })
          .from(builds)
          .where(inArray(builds.componentId, componentIds));

  const ownDeploys =
    componentIds.length === 0
      ? []
      : await context.db
          .select({ id: deploys.id })
          .from(deploys)
          .where(inArray(deploys.componentId, componentIds));

  // Read before write, for the same reason `disconnectTarget` does: the rows to
  // name are exactly the rows about to stop being observable, and reading them
  // afterwards would return nothing at all. Whole Target and vessel rows,
  // because what is read here is also what the teardown is addressed with.
  const live =
    componentIds.length === 0
      ? []
      : await context.db
          .select({
            deployId: deploys.id,
            componentId: deploys.componentId,
            targetId: deploys.targetId,
            phase: deploys.phase,
            ref: deploys.ref,
            url: deploys.url,
            component: components.name,
            componentKind: components.kind,
            schedule: components.schedule,
            target: targets,
            vessel: vessels,
          })
          .from(deploys)
          .innerJoin(components, eq(deploys.componentId, components.id))
          .innerJoin(targets, eq(deploys.targetId, targets.id))
          .innerJoin(vessels, eq(targets.vesselId, vessels.id))
          .where(
            and(
              inArray(deploys.componentId, componentIds),
              isNull(deploys.orphanedAt),
            ),
          )
          .orderBy(desc(deploys.id));

  // What the review names: the phases in which something is actually up there
  // answering (§13's grammar).
  const strandable = live.filter((deploy) =>
    STRANDABLE_PHASES.some((phase) => phase === deploy.phase),
  );

  // What the teardown addresses, which is not the same list. `ref` persists
  // through a failed re-attempt (`settle`, `deploy-loop.ts`), so the newest
  // non-orphaned Deploy that ever recorded one is the pair's current address
  // whatever its own terminal phase says — the same rule `unplaceComponent`
  // reads it by, and the reason a FAILED Deploy's half-made resource is not
  // left behind. Newest first, so the first row per pair wins.
  const addresses = new Map<string, (typeof live)[number]>();
  for (const deploy of live) {
    if (deploy.ref === null) continue;
    const pair = `${deploy.componentId} ${deploy.targetId}`;
    if (!addresses.has(pair)) addresses.set(pair, deploy);
  }

  const attached = await context.db
    .select({ name: datastores.name })
    .from(datastores)
    .where(eq(datastores.appId, app.id));

  // The scope a store item is reachable at is derived from rows this delete is
  // about to remove, so it is resolved now and used after. `secret_ref` and
  // `build_secret` both pin versions in a store; §10's website exception is a
  // plain column, and it goes with the row.
  const pinned =
    componentIds.length === 0
      ? []
      : await context.db
          .select({
            componentId: configItems.componentId,
            targetId: configItems.targetId,
            key: configItems.key,
          })
          .from(configItems)
          .where(
            and(
              inArray(configItems.componentId, componentIds),
              inArray(configItems.kind, ['secret_ref', 'build_secret']),
            ),
          );

  const effects: DeleteAppEffects = {
    appId: app.id,
    name: app.name,
    components: ownComponents.map((component) => component.name),
    builds: ownBuilds.length,
    deploys: ownDeploys.length,
    stranded: strandable.map((deploy) => ({
      deployId: String(deploy.deployId),
      component: deploy.component,
      target: targetLabel({
        vessel: deploy.vessel.name,
        adapter: deploy.target.adapter,
      }),
      url: deploy.url,
      firing: deploy.componentKind === 'job' && deploy.schedule !== null,
      nameSpent: deploy.target.adapter === 'static',
    })),
    detachedDatastores: attached.map((datastore) => datastore.name),
    configKeys: pinned.map(
      (item) =>
        `${nameOf.get(item.componentId) ?? item.componentId}/${item.key}`,
    ),
  };

  if (!input.confirm) {
    return ok({ deleted: false, ...effects });
  }

  // Resolved before the rows go, used after they have: `configSubject` reads the
  // Component and Target this scope is named from.
  const scopes = await reapableScopes(context, pinned, nameOf);

  // Torn down before the rows go, so a crash between the two leaves a retryable
  // delete rather than an orphan nothing names any more. `destroy` is contracted
  // idempotent, so the retry costs nothing.
  const retainedWorkloads: string[] = [];
  for (const deploy of addresses.values()) {
    const refusal = await teardown(context, deploy);
    if (refusal !== null) {
      retainedWorkloads.push(
        `${deploy.component} on ${targetLabel({
          vessel: deploy.vessel.name,
          adapter: deploy.target.adapter,
        })} — ${refusal}`,
      );
      continue;
    }
    // §9: withdraw whatever vanity record this placement earned. Idempotent
    // and best-effort, the same reasoning `unplaceComponent` states: the
    // workload is already gone, and a stray record is a smaller problem than
    // reporting a delete that happened as one that did not.
    try {
      await context.adapters
        .dns?.()
        ?.withdraw(dnsHandleFor(app.name, deploy.component));
    } catch {
      // Left to converge next time something else publishes or withdraws
      // this handle.
    }
  }

  // Ordered rather than left to the cascade. Two of these foreign keys are
  // `restrict` — `deploys.build_id` and `component_target_desired.desired_*` —
  // and Postgres enforces a `restrict` the moment the referenced row is deleted,
  // including when the referencing row is being deleted by the same cascade. So
  // the referencing rows go first, by hand; `components`, `config_items`,
  // `config_audit_events`, and `attempt_events` still cascade off the App, and
  // `datastores.app_id` still goes null (§11).
  await context.db.transaction(async (tx) => {
    if (componentIds.length > 0) {
      await tx
        .delete(componentTargetDesired)
        .where(inArray(componentTargetDesired.componentId, componentIds));
      await tx
        .delete(deploys)
        .where(inArray(deploys.componentId, componentIds));
      await tx.delete(builds).where(inArray(builds.componentId, componentIds));
    }
    await tx.delete(apps).where(eq(apps.id, app.id));
  });

  const retainedSecrets: string[] = [];
  for (const scope of scopes) {
    for (const key of scope.keys) {
      if (scope.subject === null) {
        retainedSecrets.push(`${scope.component}/${key}`);
        continue;
      }
      try {
        // Retention zero: every version, not the tail past the depth §10 keeps
        // for a rollback. There is nothing left to roll back to.
        await reapKey(scope.subject, key, 0);
      } catch {
        retainedSecrets.push(`${scope.component}/${key}`);
      }
    }
  }

  return ok({ deleted: true, retainedSecrets, retainedWorkloads, ...effects });
};

/**
 * Tear one workload down, answering with why not rather than throwing.
 *
 * §6 contracts `apply` not to throw and says nothing of the kind about
 * `destroy`, so the fault is the far side's to report — but here it is reported
 * *and the delete continues*, unlike `unplaceComponent` where the refusal is the
 * whole answer. The App is going either way; an unreachable Target is a thing to
 * name, not a veto on a delete the operator confirmed.
 *
 * Exported for `deleteComponent` (`../components/delete.ts`), which tears
 * down exactly the same shape of row for exactly the same reason — a second
 * copy of this would only be a second place for the reasoning to drift from
 * this one's.
 */
export async function teardown(
  context: CommandContext,
  deploy: {
    ref: string | null;
    target: { adapter: TargetAdapter; connection: TargetConnection | null };
    vessel: { location: VesselLocation | null };
  },
): Promise<string | null> {
  const { ref, target, vessel } = deploy;
  if (ref === null) return null;
  if (!hasTargetConnection(target) || !hasVesselLocation(vessel)) {
    return 'the Target is not connected, so nothing could be torn down there';
  }
  const adapter = context.adapters.deploy(target.adapter);
  if (adapter === null) {
    return `this installation has no ${target.adapter} adapter`;
  }
  try {
    await adapter.destroy(deployTargetOf(target, vessel), ref);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** One (Component, Target) scope's keys, with the store to reap them from. */
export interface ReapableScope {
  /** `null` when this scope reaches no store — its keys are simply retained. */
  readonly subject: ConfigSubject | null;
  /** The Component's name, for the sentence a retained key is reported in. */
  readonly component: string;
  readonly keys: readonly string[];
}

/**
 * Group the pinned keys by scope and resolve each scope's store, before the rows
 * that name the scope are deleted.
 *
 * A scope that resolves to a failure — a Target that reaches no store this
 * installation can write to — is kept with `reap: null` rather than dropped, so
 * its keys are reported as retained instead of silently forgotten.
 *
 * Exported alongside {@link teardown} for `deleteComponent`, over exactly the
 * one scope its single Component ever has.
 */
export async function reapableScopes(
  context: CommandContext,
  pinned: readonly { componentId: string; targetId: string; key: string }[],
  componentNames: ReadonlyMap<string, string>,
): Promise<ReapableScope[]> {
  const byScope = new Map<
    string,
    { componentId: string; targetId: string; keys: string[] }
  >();
  for (const item of pinned) {
    const scopeKey = `${item.componentId} ${item.targetId}`;
    const existing = byScope.get(scopeKey);
    if (existing) {
      existing.keys.push(item.key);
    } else {
      byScope.set(scopeKey, {
        componentId: item.componentId,
        targetId: item.targetId,
        keys: [item.key],
      });
    }
  }

  const scopes: ReapableScope[] = [];
  for (const scope of byScope.values()) {
    const subject = await configSubject(context, scope);
    scopes.push({
      subject: 'failure' in subject ? null : subject,
      component: componentNames.get(scope.componentId) ?? scope.componentId,
      keys: scope.keys,
    });
  }
  return scopes;
}
