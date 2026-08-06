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
 * workloads it would strand. The second call, with `confirm`, does it. An act
 * that removes a Component's whole build and deploy history on the first call is
 * one nobody can look at before it happens, which is the same argument §10 makes
 * about a bulk paste.
 *
 * **It never calls the deploy adapter.** This is `disconnectTarget`'s rule (§13)
 * and it is here for the same reason: destroying a workload is not what "delete
 * this record" says, and a delete that tore down a running service because its
 * bookkeeping was being tidied would be the most destructive possible reading of
 * the request. What the operator gets instead is the list, before they confirm
 * and again afterwards, because after the rows are gone that list is the only
 * record that those workloads exist — and each entry says whether it keeps
 * *acting*, not merely sitting: a stranded service is inert, but a stranded
 * `kind: job` Component with a `schedule` bills on every tick, forever, in a
 * vessel project nobody is watching (`StrandedWorkload.firing`).
 *
 * **It does reap the config store**, and that is not the same thing. §10's
 * store items are per-key material this App put there and nothing else will ever
 * read — a pin whose row is gone is unreachable, not merely unmanaged — so
 * leaving them is a leak rather than a workload. A key the store refuses to
 * destroy is named in `retainedSecrets` rather than failing the delete: the rows
 * are already gone by then, and a refusal at that point would report a delete
 * that happened as one that did not.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
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
import { STRANDABLE_PHASES, targetLabel } from '../../domain/target.ts';
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
     * what it is about to strand, so a deploy that went live between them is
     * named in the confirmation rather than quietly deleted under a review that
     * said there was nothing running.
     */
    confirm: z.boolean().default(false),
  })
  .strict();

export type DeleteAppInput = z.infer<typeof deleteAppInput>;

/** One workload that keeps running with nothing managing it (§13's grammar). */
export interface StrandedWorkload {
  readonly deployId: string;
  readonly component: string;
  /** Where it is still running — the operator has to go there by hand. */
  readonly target: string;
  readonly url: string | null;
  /**
   * Whether this stranded workload keeps *acting* rather than merely sitting.
   *
   * A stranded service is inert until something calls it; a stranded
   * `kind: job` Component with a `schedule` has a Cloud Scheduler job in front
   * of it that fires on every tick forever, billed in a vessel project nobody
   * is watching — the cost this review exists to make visible before the rows
   * that name it are gone. Derived from the Component, not the Deploy: the
   * cadence lives on `components.schedule`, and it is what fires regardless of
   * which Build is live.
   */
  readonly firing: boolean;
}

/** What deleting this App does, whether or not it has been done yet. */
export interface DeleteAppEffects {
  readonly appId: string;
  readonly name: string;
  /** Gone with the App — a Component is not a thing that reattaches (§2). */
  readonly components: readonly string[];
  readonly builds: number;
  readonly deploys: number;
  /** Named, per §13 — this list is the whole point of the confirmation. */
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
  // afterwards would return nothing at all.
  const strandable =
    componentIds.length === 0
      ? []
      : await context.db
          .select({
            deployId: deploys.id,
            url: deploys.url,
            component: components.name,
            vessel: vessels.name,
            adapter: targets.adapter,
            componentKind: components.kind,
            schedule: components.schedule,
          })
          .from(deploys)
          .innerJoin(components, eq(deploys.componentId, components.id))
          .innerJoin(targets, eq(deploys.targetId, targets.id))
          .innerJoin(vessels, eq(targets.vesselId, vessels.id))
          .where(
            and(
              inArray(deploys.componentId, componentIds),
              isNull(deploys.orphanedAt),
              inArray(deploys.phase, [...STRANDABLE_PHASES]),
            ),
          );

  const attached = await context.db
    .select({ name: datastores.name })
    .from(datastores)
    .where(eq(datastores.appId, app.id));

  // The scope a store item is reachable at is derived from rows this delete is
  // about to remove, so it is resolved now and used after. `kind: 'secret_ref'`
  // is the only kind with anything in a store — §10's website exception is a
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
              eq(configItems.kind, 'secret_ref'),
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
      target: targetLabel(deploy),
      url: deploy.url,
      firing: deploy.componentKind === 'job' && deploy.schedule !== null,
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

  return ok({ deleted: true, retainedSecrets, ...effects });
};

/** One (Component, Target) scope's keys, with the store to reap them from. */
interface ReapableScope {
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
 */
async function reapableScopes(
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
