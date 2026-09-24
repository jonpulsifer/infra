/**
 * `deleteApp`: removes an App with its Components, Builds, Deploys and config;
 * its Datastores survive, detached. Without `confirm` it only reports effects.
 * A teardown or reap the far side refuses is reported and does not fail it.
 */
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
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
     * False reviews and deletes nothing. A confirming call recomputes the
     * teardown, so a deploy that went live after the review still goes.
     */
    confirm: z.boolean().default(false),
  })
  .strict();

export type DeleteAppInput = z.infer<typeof deleteAppInput>;

/** One live workload that confirming this delete tears down. */
export interface StrandedWorkload {
  readonly deployId: string;
  readonly component: string;
  readonly target: string;
  readonly url: string | null;
  /** A scheduled job, which keeps firing and billing until torn down. */
  readonly firing: boolean;
  /**
   * Static hosting site ids are global and can never be reused once deleted,
   * so the teardown spends the name for good.
   */
  readonly nameSpent: boolean;
}

export interface DeleteAppEffects {
  readonly appId: string;
  readonly name: string;
  readonly components: readonly string[];
  readonly builds: number;
  readonly deploys: number;
  /** Live workloads, torn down on confirm. */
  readonly stranded: readonly StrandedWorkload[];
  readonly detachedDatastores: readonly string[];
  /** As `component/KEY`; confirming reaps their store items. */
  readonly configKeys: readonly string[];
}

export type DeleteAppResult =
  | ({ readonly deleted: false } & DeleteAppEffects)
  | ({
      readonly deleted: true;
      /** Store items the store refused to destroy, to remove by hand. */
      readonly retainedSecrets: readonly string[];
      /**
       * `<what> on <target> — <why>` for each refused teardown or `sweepApp`,
       * left on the Target to remove by hand.
       */
      readonly retainedWorkloads: readonly string[];
    } & DeleteAppEffects);

export const deleteApp: Command<DeleteAppInput, DeleteAppResult> = async (
  input,
  context,
) => {
  // `apps.name` has no unique constraint, so an ambiguous name is refused.
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

  // Full Target and vessel rows, because the teardown is addressed from them.
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

  const strandable = live.filter((deploy) =>
    STRANDABLE_PHASES.some((phase) => phase === deploy.phase),
  );

  // Per placement, the newest Deploy with a `ref` wins, whatever its phase:
  // `ref` survives a failed re-attempt, so a FAILED Deploy's resource goes too.
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

  // Only these kinds pin versions in a store; the others live in the row.
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

  // Resolved before the rows go: `configSubject` reads the Component and Target.
  const scopes = await reapableScopes(context, pinned, nameOf);

  // Torn down before the rows go, so a crash leaves a retryable delete.
  // `destroy` is idempotent, so the retry costs nothing.
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
    try {
      await context.adapters
        .dns?.()
        ?.withdraw(dnsHandleFor(app.name, deploy.component));
    } catch {
      // Best-effort: the workload is gone, and a stray record must not fail
      // the delete.
    }
  }

  // Then each Target's App-scoped container, such as a Kubernetes namespace,
  // which no ref names. It goes after the placements because they live in it.
  const sameName = await context.db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.name, app.name), ne(apps.id, app.id)));
  for (const target of sweepable(live)) {
    const refusal =
      // Two Apps of the same name share the container, so sweeping it would
      // take the other App's workloads.
      sameName.length > 0
        ? `${sameName.length} other App answers to '${app.name}', so its container is shared and was left in place`
        : await sweep(context, target, app.name);
    if (refusal !== null) {
      retainedWorkloads.push(
        `${app.name} on ${targetLabel({
          vessel: target.vessel.name,
          adapter: target.target.adapter,
        })} — ${refusal}`,
      );
    }
  }

  // `deploys.build_id` and the desired row's ids are `restrict`, which Postgres
  // enforces even inside a cascade, so the referencing rows go first.
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
        // Retention zero reaps every version; nothing is left to roll back to.
        await reapKey(scope.subject, key, 0);
      } catch {
        retainedSecrets.push(`${scope.component}/${key}`);
      }
    }
  }

  return ok({ deleted: true, retainedSecrets, retainedWorkloads, ...effects });
};

/**
 * Tears one workload down and returns why it could not, or `null`. It never
 * throws, so a refusing Target cannot stop a confirmed delete.
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

/** One row per Target the App's Deploys are on, which `sweepApp` addresses. */
function sweepable(
  live: readonly {
    targetId: string;
    target: { adapter: TargetAdapter; connection: TargetConnection | null };
    vessel: { name: string; location: VesselLocation | null };
  }[],
) {
  const byTarget = new Map<string, (typeof live)[number]>();
  for (const deploy of live) {
    if (!byTarget.has(deploy.targetId)) byTarget.set(deploy.targetId, deploy);
  }
  return byTarget.values();
}

/**
 * Sweeps one Target's App-scoped container, with the contract of {@link teardown}.
 * An adapter with no `sweepApp` made no container and answers `null`.
 */
async function sweep(
  context: CommandContext,
  target: {
    target: { adapter: TargetAdapter; connection: TargetConnection | null };
    vessel: { location: VesselLocation | null };
  },
  app: string,
): Promise<string | null> {
  if (
    !hasTargetConnection(target.target) ||
    !hasVesselLocation(target.vessel)
  ) {
    return 'the Target is not connected, so nothing could be swept there';
  }
  const adapter = context.adapters.deploy(target.target.adapter);
  if (adapter?.sweepApp === undefined) return null;
  try {
    await adapter.sweepApp(deployTargetOf(target.target, target.vessel), app);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

/** One (Component, Target) scope's keys, with the store to reap them from. */
export interface ReapableScope {
  /** `null` when this scope reaches no store, so its keys are reported retained. */
  readonly subject: ConfigSubject | null;
  readonly component: string;
  readonly keys: readonly string[];
}

/**
 * Groups pinned keys by scope and resolves each scope's store before the delete
 * removes the rows that name it. A scope with no store keeps `subject: null`.
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
