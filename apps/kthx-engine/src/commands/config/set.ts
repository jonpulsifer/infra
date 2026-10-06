/**
 * Writes config for one Component@Target. Values go to the store write-only and
 * rows hold the pinned reference; a website's values are plain rows. A change
 * redeploys the Build already desired there.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type {
  ConfigScope,
  SecretStore,
} from '../../adapters/store/contract.ts';
import type { StoreAdapter } from '../../config/manifest.schema.ts';
import type { Database } from '../../db/client.ts';
import {
  components,
  componentTargetDesired,
  configAuditEvents,
  configItems,
  PINNED_ENVIRONMENT,
  type Target,
} from '../../db/schema.ts';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import {
  CONFIG_RETENTION,
  reapable,
  storeOfRecordFor,
  VARIABLE_NAME,
} from '../../domain/config.ts';
import type { ComponentKind } from '../../domain/desired-state.ts';
import { targetRowLabel } from '../../domain/target.ts';
import {
  checkDeployable,
  deliveringConfig,
  placeIntent,
} from '../deploys/create.ts';
import {
  type AdapterRegistry,
  type Command,
  type CommandContext,
  type CommandFailure,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';
import { isBuildTimeConfig } from './build-args.ts';
import {
  configScopeFor,
  type PinnedConfig,
  readPinnedConfig,
} from './pinned.ts';

const configEntry = z
  .object({
    key: z
      .string()
      .regex(VARIABLE_NAME, 'must be an environment variable name'),
    /** Empty is legal: set but blank is a different state from unset. */
    value: z.string(),
  })
  .strict();

export const setConfigInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    entries: z.array(configEntry).optional(),
    removals: z
      .array(
        z.string().regex(VARIABLE_NAME, 'must be an environment variable name'),
      )
      .optional(),
  })
  .strict();

export type SetConfigInput = z.infer<typeof setConfigInput>;

/** Keys and a hash, never values. */
export interface ConfigChangeResult {
  readonly componentId: string;
  readonly targetId: string;
  /** Sorted. */
  readonly written: readonly string[];
  /** Sorted. */
  readonly removed: readonly string[];
  readonly configVersion: string;
  /** Null when no Deploy followed. */
  readonly deployId: number | null;
  /** Why no Deploy followed, as a sentence. */
  readonly notDeployed: string | null;
}

export const setConfig: Command<SetConfigInput, ConfigChangeResult> = async (
  input,
  context,
) => {
  const entries = input.entries ?? [];
  const removals = input.removals ?? [];
  if (entries.length === 0 && removals.length === 0) {
    return failed('INVALID_INPUT', 'nothing to set or remove');
  }

  const subject = await configSubject(context, input);
  if ('failure' in subject) return { ok: false, failure: subject.failure };

  const duplicate = firstDuplicate(entries.map((entry) => entry.key));
  if (duplicate !== null) {
    return failed(
      'INVALID_INPUT',
      `${duplicate} appears twice — one secret per variable (§10), so one value per key`,
    );
  }

  const contested = entries
    .map((entry) => entry.key)
    .find((key) => removals.includes(key));
  if (contested !== undefined) {
    return failed(
      'INVALID_INPUT',
      `${contested} is both set and removed in the same call`,
    );
  }

  return applyConfigChange(context, subject, entries, removals);
};

export interface ConfigSubject {
  readonly componentId: string;
  readonly targetId: string;
  /** The website exception is derived from this alone. */
  readonly kind: ComponentKind;
  readonly scope: ConfigScope;
  /** Null exactly when the config is baked at build time, as a website's is. */
  readonly store: SecretStore | null;
}

/**
 * Refuses a Target that reaches no writable store: config written there would
 * deploy green with no environment.
 */
export async function configSubject(
  context: CommandContext,
  input: { componentId: string; targetId: string },
): Promise<ConfigSubject | { failure: CommandFailure }> {
  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, input.componentId));
  if (component === undefined) {
    return {
      failure: {
        code: 'NOT_FOUND',
        message: `there is no Component with id ${input.componentId}`,
      },
    };
  }

  // With its vessel, because part of a Target's label lives there.
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, input.targetId),
    with: { vessel: true },
  });
  if (target === undefined) {
    return {
      failure: {
        code: 'NOT_FOUND',
        message: `there is no Target with id ${input.targetId}`,
      },
    };
  }

  // A website's config is baked into the build, never delivered, so it needs no
  // store this Target reaches.
  const buildTime = isBuildTimeConfig(component.kind);
  const adapter = buildTime ? null : storeOfRecordOf(context, target);
  if (!buildTime && adapter === null) {
    return {
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `${targetRowLabel(target)} reaches no secret store this installation can write to, so config set here would be delivered by nobody`,
      },
    };
  }

  const scope = await configScopeFor(context.db, component.id, target.id);
  if (scope === null) {
    return {
      failure: {
        code: 'NOT_FOUND',
        message: `there is no Component with id ${input.componentId}`,
      },
    };
  }

  return {
    componentId: component.id,
    targetId: target.id,
    kind: component.kind,
    scope,
    // Non-null unless this is a website: `storeOfRecordOf` only picks an adapter
    // the registry answered for.
    store: adapter === null ? null : context.adapters.store(adapter),
  };
}

/**
 * A store this Target can reach and this installation has an adapter for, or
 * `null`.
 */
export function storeOfRecordOf(
  context: {
    readonly manifest: CommandContext['manifest'];
    readonly adapters: Pick<AdapterRegistry, 'deploy' | 'store'>;
  },
  target: Target,
): StoreAdapter | null {
  const capabilities = capabilitiesOfRow(target, {
    artifactTypes:
      context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
    manifest: context.manifest,
  });
  return storeOfRecordFor(
    capabilities.reachableSecretStores,
    (adapter) => context.adapters.store(adapter) !== null,
    context.manifest.secretStore.adapter,
  );
}

/**
 * Each key's `put` precedes its row, so a store that fails partway leaves every
 * pin written so far naming a version that exists.
 */
export async function applyConfigChange(
  context: CommandContext,
  subject: ConfigSubject,
  entries: readonly { key: string; value: string }[],
  removals: readonly string[],
): Promise<CommandResult<ConfigChangeResult>> {
  // A build secret changes only through setBuildSecrets. Converting it here would
  // hand the runtime the credential that list keeps away from it.
  const touched = [...entries.map((entry) => entry.key), ...removals];
  if (touched.length > 0) {
    const [held] = await context.db
      .select({ key: configItems.key })
      .from(configItems)
      .where(
        and(
          eq(configItems.componentId, subject.componentId),
          eq(configItems.targetId, subject.targetId),
          eq(configItems.environment, PINNED_ENVIRONMENT),
          eq(configItems.kind, 'build_secret'),
          inArray(configItems.key, touched),
        ),
      );
    if (held !== undefined) {
      return failed(
        'INVALID_INPUT',
        `${held.key} is a build secret on this pair — it is a separate list ` +
          'the runtime never holds, so change it through setBuildSecrets, ' +
          'and remove it there first if this key is meant to become config',
      );
    }
  }

  const now = context.clock.now();
  const written: string[] = [];
  const { store } = subject;

  for (const entry of entries) {
    // A website's value becomes public once the site is served, so it is a plain
    // row and never crosses the store seam.
    const row =
      store === null
        ? {
            kind: 'plain' as const,
            storeRef: null,
            storeVersion: null,
            plainValue: entry.value,
          }
        : await pinnedRow(store, subject.scope, entry);

    await context.db
      .insert(configItems)
      .values({
        componentId: subject.componentId,
        targetId: subject.targetId,
        environment: PINNED_ENVIRONMENT,
        key: entry.key,
        createdAt: now,
        updatedAt: now,
        ...row,
      })
      .onConflictDoUpdate({
        target: [
          configItems.componentId,
          configItems.targetId,
          configItems.environment,
          configItems.key,
        ],
        set: { ...row, updatedAt: now },
      });
    written.push(entry.key);
    await auditConfigChange(context, subject, entry.key, 'set', now);
  }

  for (const key of removals) {
    await context.db
      .delete(configItems)
      .where(
        and(
          eq(configItems.componentId, subject.componentId),
          eq(configItems.targetId, subject.targetId),
          eq(configItems.environment, PINNED_ENVIRONMENT),
          eq(configItems.key, key),
        ),
      );
    await auditConfigChange(context, subject, key, 'removed', now);
  }

  // Removed keys are reaped too, because their store versions outlive the
  // document. The newest versions survive, so a rollback inside the window resolves.
  if (store !== null) {
    for (const key of [...written, ...removals]) {
      await reapKey(subject, key);
    }
  }

  const pinned = await readPinnedConfig(
    context.db,
    subject.componentId,
    subject.targetId,
  );
  const deployed = await deployChange(context, subject, pinned);

  return ok({
    componentId: subject.componentId,
    targetId: subject.targetId,
    written: [...written].sort(),
    removed: [...removals].sort(),
    configVersion: pinned.version,
    deployId: deployed.deployId,
    notDeployed: deployed.notDeployed,
  });
}

/** The value goes in; only the store's reference comes back. */
async function pinnedRow(
  store: SecretStore,
  scope: ConfigScope,
  entry: { key: string; value: string },
): Promise<{
  kind: 'secret_ref';
  storeRef: string;
  storeVersion: string;
  plainValue: null;
}> {
  const reference = await store.put(scope, entry.key, entry.value);
  return {
    kind: 'secret_ref',
    storeRef: reference.key,
    storeVersion: reference.version,
    plainValue: null,
  };
}

/** Destroys every version past the retention depth and returns how many. */
export async function reapKey(
  subject: ConfigSubject,
  key: string,
  retention: number = CONFIG_RETENTION,
): Promise<number> {
  if (subject.store === null) return 0;
  const versions = await subject.store.versions(subject.scope, key);
  const expired = reapable(versions, retention);
  for (const version of expired) {
    await subject.store.destroy(version.reference);
  }
  return expired.length;
}

/**
 * Redeploys the Build already desired here with the new config. With nothing
 * desired, the first deploy picks the config up.
 */
async function deployChange(
  context: CommandContext,
  subject: ConfigSubject,
  pinned: PinnedConfig,
): Promise<{ deployId: number | null; notDeployed: string | null }> {
  // A website's value is baked into the serving artifact. Re-applying it would
  // deliver the old value under a new `configVersion`.
  if (isBuildTimeConfig(subject.kind)) {
    return {
      deployId: null,
      notDeployed:
        'a website bakes its configuration into the artifact, so this value reaches the site on its next build',
    };
  }

  const [desired] = await context.db
    .select({ buildId: componentTargetDesired.desiredBuildId })
    .from(componentTargetDesired)
    .where(
      and(
        eq(componentTargetDesired.componentId, subject.componentId),
        eq(componentTargetDesired.targetId, subject.targetId),
      ),
    );

  const buildId = desired?.buildId ?? null;
  if (buildId === null) {
    return {
      deployId: null,
      notDeployed:
        'nothing is deployed here yet, so this configuration will be delivered by the first deploy',
    };
  }

  const checked = await checkDeployable(
    {
      componentId: subject.componentId,
      targetId: subject.targetId,
      buildId,
    },
    context,
  );
  if (!checked.ok) {
    return { deployId: null, notDeployed: checked.failure.message };
  }

  const placed = await placeIntent(
    context,
    deliveringConfig(checked.value, pinned),
  );
  return placed.ok
    ? { deployId: placed.value.deployId, notDeployed: null }
    : { deployId: null, notDeployed: placed.failure.message };
}

/** Metadata only: who changed which key, and when. */
export async function auditConfigChange(
  context: CommandContext,
  subject: ConfigSubject,
  key: string,
  action: 'set' | 'removed',
  at: Date,
): Promise<void> {
  await context.db.insert(configAuditEvents).values({
    componentId: subject.componentId,
    targetId: subject.targetId,
    key,
    action,
    userId: context.principal.id,
    displayName: context.principal.displayName,
    createdAt: at,
  });
}

function firstDuplicate(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/**
 * Secret references and plain rows, sorted. Build secrets are a separate list
 * that no runtime document contains.
 */
export async function configuredKeys(
  db: Database,
  componentId: string,
  targetId: string,
): Promise<string[]> {
  const rows = await db
    .select({ key: configItems.key })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        inArray(configItems.kind, ['secret_ref', 'plain']),
      ),
    );
  return rows.map((row) => row.key).sort();
}
