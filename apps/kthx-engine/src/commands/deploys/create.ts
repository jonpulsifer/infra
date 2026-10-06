/**
 * `createDeploy` writes an intent to change what is live at one
 * Component@Target. It applies nothing and dispatches no build: the deploy loop
 * picks the row up.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  datastores,
  deploys,
} from '../../db/schema.ts';
import { DEFAULT_MINIMUM_BUILD_LEVEL } from '../../domain/build-route.ts';
import {
  DATASTORE_VARIABLE,
  type DesiredDocument,
} from '../../domain/desired-state.ts';
import {
  artifactTypeFor,
  DEFAULT_PLATFORM,
  placementTargetOf,
  reachExclusions,
  sentence,
  takesShape,
} from '../../domain/placement.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { demandSentence, migrationFor } from '../config/migration.ts';
import { type PinnedConfig, readPinnedConfig } from '../config/pinned.ts';
import { storeOfRecordOf } from '../config/set.ts';
import {
  type Command,
  type CommandContext,
  type CommandFailure,
  type CommandFailureCode,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

export const createDeployInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    buildId: z.number().int().positive(),
  })
  .strict();

export type CreateDeployInput = z.infer<typeof createDeployInput>;

export interface CreateDeployResult {
  readonly deployId: number;
  readonly componentId: string;
  readonly targetId: string;
  readonly buildId: number;
  readonly phase: 'PENDING';
  /** The Build desired here before this intent, or `null` on a first deploy. */
  readonly supersededBuildId: number | null;
  /** A hash of the config this attempt delivers, never the config itself. */
  readonly configVersion: string;
}

export interface DeployPreconditions {
  readonly componentId: string;
  readonly targetId: string;
  readonly buildId: number;
  /**
   * Captured at intent time, so a rollback places what its Deploy recorded, not
   * what the Component and config rows say today.
   */
  readonly desired: DesiredDocument;
  /** A hash of `desired.config`, stored because the UI lists it. */
  readonly configVersion: string;
  /** Skip the App lock; carried so `placeIntent` re-checks it the same way. */
  readonly bypassLock?: boolean;
}

/**
 * The same preconditions with a new config document, for a config change that
 * deploys what was just written. Nothing else in the release changes.
 */
export function deliveringConfig(
  value: DeployPreconditions,
  config: PinnedConfig,
): DeployPreconditions {
  return {
    ...value,
    configVersion: config.version,
    desired: { ...value.desired, config: config.document },
  };
}

/**
 * The same preconditions redelivering a rollback's config, plus its schedule,
 * command and args where it had them. Exposure, reach, auth and datastores stay
 * as they are today.
 */
export function deliveringRelease(
  value: DeployPreconditions,
  previous: {
    readonly desired: DesiredDocument;
    readonly configVersion: string;
  },
): DeployPreconditions {
  const was = previous.desired;
  return {
    ...value,
    configVersion: previous.configVersion,
    desired: {
      ...value.desired,
      config: was.config,
      // Conditional: a field the old release lacked keeps today's value
      // instead of becoming undefined.
      ...(was.schedule === undefined ? {} : { schedule: was.schedule }),
      ...(was.command === undefined ? {} : { command: was.command }),
      ...(was.args === undefined ? {} : { args: was.args }),
    },
  };
}

export type DeployCheck =
  | { readonly ok: true; readonly value: DeployPreconditions }
  | { readonly ok: false; readonly failure: CommandFailure };

function refuse(code: CommandFailureCode, message: string): DeployCheck {
  return { ok: false, failure: { code, message } };
}

function lockedSentence(appName: string, reason: string): string {
  return `'${appName}' is locked — ${reason}. Unlock it to deploy again; a rollback goes through regardless`;
}

function names(rows: readonly { readonly name: string }[]): string {
  return rows.map((row) => row.name).join(', ');
}

export const createDeploy: Command<
  CreateDeployInput,
  CreateDeployResult
> = async (input, context) => {
  const checked = await checkDeployable(input, context);
  if (!checked.ok) return { ok: false, failure: checked.failure };
  return placeIntent(context, checked.value);
};

/**
 * Names the pinned config keys the store can no longer describe, or `null`.
 * A rollback past a reaped version would otherwise come up unconfigured.
 */
async function unresolvedPins(
  context: CommandContext,
  checked: DeployPreconditions,
): Promise<string | null> {
  const config = checked.desired.config;
  if (config.length === 0) return null;

  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, checked.targetId),
    with: { vessel: true },
  });
  if (target === undefined) return null;

  const adapter = storeOfRecordOf(context, target);
  // No store of record means no versions to check, not reaped ones.
  if (adapter === null) return null;
  const store = context.adapters.store(adapter);
  if (store === null) return null;

  const gone: string[] = [];
  for (const entry of config) {
    // In document order. A throw propagates: an outage is not a reaped version.
    if ((await store.describe(entry.secret)) === null) gone.push(entry.name);
  }
  if (gone.length === 0) return null;

  return (
    `this release is pinned to config versions that no longer exist in ${targetRowLabel(target)}: ` +
    `${gone.join(', ')}. Deploying it would bring the Component up without them, so it is refused — ` +
    'set each one again to mint a new version, which deploys as an ordinary change.'
  );
}

/**
 * Writes the intent in one transaction that opens with a locking read on the
 * desired row, so two deploys of one pair serialize.
 */
export async function placeIntent(
  context: CommandContext,
  checked: DeployPreconditions,
  /** A veto run under the lock: a sentence refuses, `null` proceeds. */
  guard?: (
    desiredBuildId: number | null,
  ) => string | null | Promise<string | null>,
  /**
   * A write on the intent's transaction, after the desired row points at the
   * new Deploy. A throw rolls the intent back with it.
   */
  onPlaced?: (
    tx: Pick<Database, 'update'>,
    placed: {
      readonly appId: string;
      readonly supersededBuildId: number | null;
    },
  ) => Promise<void>,
): Promise<CommandResult<CreateDeployResult>> {
  // Outside the transaction: this asks the store while holding no row lock.
  const unresolved = await unresolvedPins(context, checked);
  if (unresolved !== null) return failed('NOT_DEPLOYABLE', unresolved);

  const now = context.clock.now();

  const placed = await context.db.transaction(async (tx) => {
    // Insert first, so a concurrent first deploy blocks on the unique index
    // until this commits instead of failing on it.
    await tx
      .insert(componentTargetDesired)
      .values({
        componentId: checked.componentId,
        targetId: checked.targetId,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const [desired] = await tx
      .select()
      .from(componentTargetDesired)
      .where(
        and(
          eq(componentTargetDesired.componentId, checked.componentId),
          eq(componentTargetDesired.targetId, checked.targetId),
        ),
      )
      .for('update');

    const supersededBuildId = desired?.desiredBuildId ?? null;

    // The App lock again, under the pair's lock, so a rollback's hold is seen.
    // A plain read: FOR SHARE would deadlock two rollbacks on different pairs.
    const [app] = await tx
      .select({
        id: apps.id,
        name: apps.name,
        lockReason: apps.lockReason,
      })
      .from(apps)
      .innerJoin(components, eq(components.appId, apps.id))
      .where(eq(components.id, checked.componentId));
    if (app!.lockReason !== null && !checked.bypassLock) {
      return {
        vetoed: lockedSentence(app!.name, app!.lockReason),
        deployId: null,
        supersededBuildId: null,
      };
    }

    const vetoed = (await guard?.(supersededBuildId)) ?? null;
    if (vetoed !== null) {
      return { vetoed, deployId: null, supersededBuildId: null };
    }

    // A first deploy sets the placement. Only when unset, so a rollback or
    // config change aimed at a retired pair never moves a placed Component.
    await tx
      .update(components)
      .set({ placedTargetId: checked.targetId })
      .where(
        and(
          eq(components.id, checked.componentId),
          isNull(components.placedTargetId),
        ),
      );

    const [deploy] = await tx
      .insert(deploys)
      .values({
        componentId: checked.componentId,
        targetId: checked.targetId,
        buildId: checked.buildId,
        phase: 'PENDING',
        desired: checked.desired,
        configVersion: checked.configVersion,
        // Pushes carry the auto-deploy principal, telling a push from a press.
        requestedBy: context.principal.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx
      .update(componentTargetDesired)
      .set({
        desiredBuildId: checked.buildId,
        desiredDeployId: deploy!.id,
        updatedAt: now,
      })
      .where(eq(componentTargetDesired.id, desired!.id));

    await onPlaced?.(tx, { appId: app!.id, supersededBuildId });

    return { vetoed: null, deployId: deploy!.id, supersededBuildId };
  });

  if (placed.vetoed !== null) {
    return failed('NOT_DEPLOYABLE', placed.vetoed);
  }

  return ok({
    deployId: placed.deployId,
    componentId: checked.componentId,
    targetId: checked.targetId,
    buildId: checked.buildId,
    phase: 'PENDING' as const,
    supersededBuildId: placed.supersededBuildId,
    configVersion: checked.configVersion,
  });
}

/**
 * Checks made before the lock: none can change to make a committed intent
 * wrong, except the App lock, which `placeIntent` asks again.
 */
export async function checkDeployable(
  input: CreateDeployInput,
  context: CommandContext,
  options: {
    /** For a rollback, the one intent the App lock does not hold. */
    readonly bypassLock?: boolean;
  } = {},
): Promise<DeployCheck> {
  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, input.componentId));
  if (component === undefined) {
    return refuse(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  const [app] = await context.db
    .select()
    .from(apps)
    .where(eq(apps.id, component.appId));
  if (app === undefined) {
    // Unreachable while the foreign key holds.
    return refuse('NOT_FOUND', `Component ${component.name} has no App`);
  }

  // The operator's lock refuses first, in their own words.
  if (app.lockReason !== null && !options.bypassLock) {
    return refuse('NOT_DEPLOYABLE', lockedSentence(app.name, app.lockReason));
  }

  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, input.targetId),
    with: { vessel: true },
  });
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no Target with id ${input.targetId}`);
  }

  const [build] = await context.db
    .select()
    .from(builds)
    .where(eq(builds.id, input.buildId));
  if (build === undefined) {
    return failed('NOT_FOUND', `there is no Build with id ${input.buildId}`);
  }

  if (build.componentId !== component.id) {
    return refuse(
      'NOT_DEPLOYABLE',
      'that Build belongs to a different Component',
    );
  }

  if (target.status !== 'connected') {
    return refuse(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} is disconnected, so nothing new can be placed on it`,
    );
  }

  if (build.status !== 'SUCCEEDED' || build.artifactDigest === null) {
    return refuse(
      'NOT_DEPLOYABLE',
      `Build ${build.id} has no artifact — it is ${build.status.toLowerCase()}`,
    );
  }

  // Policy is read at every placement, rollback included.
  if (build.artifactType === 'image') {
    const requiredLevel = target.minBuildLevel ?? DEFAULT_MINIMUM_BUILD_LEVEL;
    if (build.verifiedBuildLevel === null || build.signature === null) {
      return refuse(
        'NOT_DEPLOYABLE',
        `Build ${build.id} has no verified provenance and core signature`,
      );
    }
    if (build.verifiedBuildLevel < requiredLevel) {
      return refuse(
        'NOT_DEPLOYABLE',
        `Build ${build.id} achieved verified Build Level ${build.verifiedBuildLevel}, and ${targetRowLabel(target)} currently requires L${requiredLevel}`,
      );
    }
    // Re-verified before any intent is written; every image adapter relies on
    // this gate. A signature that does not verify fails closed.
    const admitted = await context.adapters.supplyChain().verifySignature({
      artifactDigest: build.artifactDigest,
      signature: build.signature,
    });
    if (!admitted.ok) {
      return refuse(
        'NOT_DEPLOYABLE',
        `Build ${build.id} signature did not verify` +
          (admitted.reason === null ? '' : `: ${admitted.reason}`),
      );
    }
  }

  // Accept-list membership, not equality with what a fresh build here would
  // take: Vercel prefers vercel-output and still serves plain files.
  const placement = placementTargetOf(target, {
    artifactTypes:
      context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
    manifest: context.manifest,
  });
  if (!takesShape(component.kind, build.targetShape, placement)) {
    const shape = artifactTypeFor(component.kind, placement);
    return refuse(
      'NOT_DEPLOYABLE',
      `Build ${build.id} produced ${build.targetShape}, and ${targetRowLabel(target)} takes ${shape} — this placement needs a rebuild`,
    );
  }

  // Reach is a network boundary, so it binds here too. Only reach and auth:
  // other exclusions, such as UNHEALTHY, would block a rollback.
  const unserved = reachExclusions(placement.capabilities, component);
  if (unserved.length > 0) {
    const why = unserved
      .map((reason) =>
        sentence(reason, {
          kind: component.kind,
          reach: component.reach,
          platform: DEFAULT_PLATFORM,
        }),
      )
      .join('; ');
    return refuse(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} does not serve this Component's ${component.reach} reach — ${why}`,
    );
  }

  // Also checked in placeComponent. A deploy straight at an unplaced Target
  // would otherwise come up green and missing its config.
  const migration = await migrationFor(
    context.db,
    context,
    component.id,
    target.id,
  );
  if (migration.demanded.length > 0) {
    return refuse(
      'NOT_DEPLOYABLE',
      demandSentence(migration.demanded, targetRowLabel(target)),
    );
  }

  const config = await readPinnedConfig(context.db, component.id, target.id);

  const attached = await context.db
    .select({
      name: datastores.name,
      engine: datastores.engine,
      connectionRef: datastores.connectionRef,
      vesselId: datastores.vesselId,
    })
    .from(datastores)
    .where(eq(datastores.appId, app.id));

  // A Datastore's credential reaches only its own vessel; elsewhere the pod
  // sits in CreateContainerConfigError and the Deploy reports a timeout.
  const elsewhere = attached.filter((row) => row.vesselId !== target.vesselId);
  if (elsewhere.length > 0) {
    return refuse(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} cannot reach ${names(elsewhere)} — a Datastore is delivered only into the vessel it lives in`,
    );
  }

  const unprovisioned = attached.filter((row) => row.connectionRef === null);
  if (unprovisioned.length > 0) {
    return refuse(
      'NOT_DEPLOYABLE',
      `${names(unprovisioned)} ${unprovisioned.length === 1 ? 'is' : 'are'} still provisioning and ${unprovisioned.length === 1 ? 'has' : 'have'} no connection to deliver yet`,
    );
  }

  return {
    ok: true,
    value: {
      componentId: component.id,
      targetId: target.id,
      buildId: build.id,
      configVersion: config.version,
      ...(options.bypassLock ? { bypassLock: true } : {}),
      desired: {
        app: app.name,
        component: component.name,
        target: targetRowLabel(target),
        kind: component.kind,
        // Absent, not null: the chart branches on emptiness.
        ...(component.expose === null ? {} : { expose: component.expose }),
        reach: component.reach,
        auth: component.auth,
        ...(component.schedule === null
          ? {}
          : { schedule: component.schedule }),
        // Null on the row means the image's own entrypoint.
        ...(component.command === null ? {} : { command: component.command }),
        ...(component.args === null ? {} : { args: component.args }),
        config: config.document,
        // Absent when empty, like documents stored before datastores existed.
        ...(attached.length === 0
          ? {}
          : {
              datastores: attached.map((row) => ({
                // Nothing downstream sees the engine, only its variable.
                name: DATASTORE_VARIABLE[row.engine],
                connection: row.connectionRef as string,
              })),
            }),
        // Nothing detects a platform or size yet; this is where that would go.
        requirements: { platform: DEFAULT_PLATFORM, resources: {} },
      },
    },
  };
}
