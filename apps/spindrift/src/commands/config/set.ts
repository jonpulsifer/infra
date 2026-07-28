/**
 * `setConfig` — write configuration for one Component@Target (§10).
 *
 * §10 in one line: **plain key-value, one mechanism, no classification, values
 * write-only, one secret per variable, pinned, and a change produces a new
 * Deploy.** Each of those is a line of code here rather than a convention:
 *
 * - **No classification.** There is no `secret: boolean` in the input and no
 *   place to put one. The asymmetry of error decides it — over-classifying
 *   costs pennies, under-classifying puts a credential inline in a delivery CR
 *   — so every variable goes to the store.
 * - **Write-only.** The value crosses one seam, in one direction, and is not
 *   returned, logged, or stored: what lands in `config_items` is the pinned
 *   reference the store minted. The result carries key names and a hash.
 * - **One secret per variable.** One `put` per key, never a blob — the blob is
 *   elegant on Kubernetes and has no cloud-runtime equivalent.
 * - **A change produces a new Deploy.** Not bookkeeping: on Kubernetes a
 *   changed reference that nothing re-applies is a workload still running the
 *   old value, so the act ends by writing an intent. Where nothing is deployed
 *   here yet, there is nothing to re-apply and the act says so rather than
 *   inventing a Deploy with no Build.
 * - **The reach rule.** The store must be reachable by *this* Target (§10), and
 *   config written for a Target that cannot reach it would be delivered by
 *   nobody.
 *
 * The audit trail is written here too, and it is metadata: who changed which
 * key when. There is no value column in `config_audit_events` to fill even if
 * this file wanted to.
 */
import { and, eq } from 'drizzle-orm';
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
  targets,
} from '../../db/schema.ts';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import {
  CONFIG_RETENTION,
  reapable,
  storeOfRecordFor,
  VARIABLE_NAME,
} from '../../domain/config.ts';
import type { ComponentKind } from '../../domain/desired-state.ts';
import { checkDeployable, placeIntent } from '../deploys/create.ts';
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

/** One variable and the value nothing will ever read back (§10). */
const configEntry = z
  .object({
    key: z
      .string()
      .regex(VARIABLE_NAME, 'must be an environment variable name'),
    /**
     * Empty is a legal value — "set but blank" is a state a workload can
     * distinguish from unset, and refusing it here would make the only way to
     * express it a variable that is absent, which means something else.
     */
    value: z.string(),
  })
  .strict();

export const setConfigInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    entries: z.array(configEntry).min(1),
  })
  .strict();

export type SetConfigInput = z.infer<typeof setConfigInput>;

/**
 * What a config act returns.
 *
 * Keys and a hash, never values — the same posture the store contract takes, so
 * a UI built on this cannot render a secret it was handed by accident.
 */
export interface ConfigChangeResult {
  readonly componentId: string;
  readonly targetId: string;
  /** The keys this act wrote, sorted. */
  readonly written: readonly string[];
  /** The keys this act removed, sorted. */
  readonly removed: readonly string[];
  /** §10's hash over the document now pinned for this pair. */
  readonly configVersion: string;
  /** The Deploy the change produced, or `null` with the reason below. */
  readonly deployId: number | null;
  /**
   * Why no Deploy followed.
   *
   * A sentence rather than silence: "the config saved and nothing is running it
   * yet" and "the config saved and the Target is disconnected" are different
   * situations, and a `null` deploy id alone cannot tell them apart.
   */
  readonly notDeployed: string | null;
}

export const setConfig: Command<SetConfigInput, ConfigChangeResult> = async (
  input,
  context,
) => {
  const subject = await configSubject(context, input);
  if ('failure' in subject) return { ok: false, failure: subject.failure };

  const duplicate = firstDuplicate(input.entries.map((entry) => entry.key));
  if (duplicate !== null) {
    return failed(
      'INVALID_INPUT',
      `${duplicate} appears twice — one secret per variable (§10), so one value per key`,
    );
  }

  return applyConfigChange(context, subject, input.entries, []);
};

/** Everything a config act needs about what it is acting on. */
export interface ConfigSubject {
  readonly componentId: string;
  readonly targetId: string;
  /** §10's exception is derived from this and from nothing else. */
  readonly kind: ComponentKind;
  readonly scope: ConfigScope;
  /**
   * `null` exactly when this Component's configuration is baked at build time
   * (§10's narrow website exception).
   *
   * A website reaches no store because it needs none: its configuration is
   * ordinary rows a builder receives as build arguments, which is what keeps
   * §4's "no builder ever holds a store credential" structural rather than a
   * rule somebody has to remember.
   */
  readonly store: SecretStore | null;
}

/**
 * Resolve and check what is being configured, once.
 *
 * The reach rule is the interesting half. §10 binds the store to "the Target
 * the Component is placed on — not every Target", so it is checked against this
 * Target's discovered capabilities. Refusing here is what stops config from
 * being written into a store the workload's Target has no path to, which would
 * otherwise surface as a Deploy that comes up green with no environment.
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

  const [target] = await context.db
    .select()
    .from(targets)
    .where(eq(targets.id, input.targetId));
  if (target === undefined) {
    return {
      failure: {
        code: 'NOT_FOUND',
        message: `there is no Target with id ${input.targetId}`,
      },
    };
  }

  // The reach rule is about delivery, and a website's configuration is not
  // delivered — it is baked (§10). Checking a store a website will never touch
  // would refuse a perfectly good act on a Target that reaches no vault.
  const buildTime = isBuildTimeConfig(component.kind);
  const adapter = buildTime ? null : storeOfRecordOf(context, target);
  if (!buildTime && adapter === null) {
    return {
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `${target.name} reaches no secret store this installation can write to, so config set here would be delivered by nobody`,
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
    // Non-null unless this is a website: `storeOfRecordOf` only ever chooses an
    // adapter the registry answered for.
    store: adapter === null ? null : context.adapters.store(adapter),
  };
}

/**
 * The store of record for one Target (§10), or `null` if it has none.
 *
 * The two halves it folds together are §3's capabilities — what this Target can
 * reach — and the registry — what this installation has an access path to. A
 * store that satisfies only one of them is a store no value can travel through.
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
 * Write the values, drop the removals, and deploy what changed.
 *
 * The order matters within each key: the `put` precedes the row, so a store
 * that refuses half way through leaves every pin written so far naming a
 * version that exists, and the keys after it untouched. There is no transaction
 * that could cover both sides — the store is not in the database — so the
 * partial state is chosen rather than hoped away, and the choice is the one
 * where no reference points at nothing.
 */
export async function applyConfigChange(
  context: CommandContext,
  subject: ConfigSubject,
  entries: readonly { key: string; value: string }[],
  removals: readonly string[],
): Promise<CommandResult<ConfigChangeResult>> {
  const now = context.clock.now();
  const written: string[] = [];
  // Narrowed once, here, so nothing below asserts a store it cannot see: the
  // store is present exactly when the configuration is delivered rather than
  // baked, and `configSubject` is what established that.
  const { store } = subject;

  for (const entry of entries) {
    // §10's narrow exception, and the one place it is applied: a website's
    // value never crosses the store seam, because it is going to be public the
    // moment the site is served. Everything else goes to the store, unread.
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
    await audit(context, subject, entry.key, 'set', now);
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
    await audit(context, subject, key, 'removed', now);
  }

  // Retention applies to what was just written and to what was just removed,
  // and for the same reason: core owns config lifecycle (§10), and a key that
  // is gone from the document still has versions in the store that nothing else
  // will ever come back for. The newest N survive either way, so a rollback
  // inside the retention window still resolves.
  //
  // A website has nothing to reap: its rows *are* the values, so there are no
  // versions in a store to fall past a depth.
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

/**
 * Write one value to the store and return the row that pins it (§10).
 *
 * The value is an argument and never a return: what comes back is the reference
 * the store minted, which is the only thing above this line that a database
 * column will ever hold.
 */
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

/** Destroy every version of one key past the retention depth (§10). */
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
 * Turn a config change into a Deploy, or say why it did not (§10).
 *
 * The Build is whatever is desired at this pair right now — a config change
 * redeploys what is running, never something else — so this is an ordinary
 * deploy of the artifact that is already live, with a new `configVersion`. A
 * pair with nothing desired has nothing to redeploy, and the first deploy will
 * pick the config up when it captures its own document.
 */
async function deployChange(
  context: CommandContext,
  subject: ConfigSubject,
  pinned: PinnedConfig,
): Promise<{ deployId: number | null; notDeployed: string | null }> {
  // A website's value was baked into the artifact that is already serving, so
  // re-applying that artifact would deliver the old value with a new
  // `configVersion` beside it — green, and wrong. The new value reaches the
  // site the next time one is built, and saying so is the honest answer.
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

  const placed = await placeIntent(context, {
    ...checked.value,
    config: pinned,
  });
  return placed.ok
    ? { deployId: placed.value.deployId, notDeployed: null }
    : { deployId: null, notDeployed: placed.failure.message };
}

/** One metadata-only audit row: who changed which key when (§10). */
async function audit(
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

/** The first key given twice, or `null`. */
function firstDuplicate(keys: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
}

/** Every key currently configured for one pair, sorted. */
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
      ),
    );
  return rows.map((row) => row.key).sort();
}
