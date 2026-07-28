/**
 * Reading config the way everything above it needs it: as a pinned document
 * and its version, never as values (§10).
 *
 * Four callers share this — `set`, `replace`, `place`, and the two deploy
 * commands — and they share it because the alternative is five places that each
 * decide what "the config of a Component@Target" means. The one that matters is
 * the deploy path: a Deploy records the document it was given, and if this
 * function returned rows in a different shape than the one the hash is defined
 * over, `configVersion` would change without the configuration changing.
 *
 * **There is no `value` anywhere below.** The columns selected are the key and
 * the two halves of the pin; `plain_value` is the narrow website exception (§10)
 * and belongs to build arguments, not to delivery.
 */
import { and, eq } from 'drizzle-orm';
import type { ConfigScope } from '../../adapters/store/contract.ts';
import type { Database } from '../../db/client.ts';
import {
  apps,
  components,
  configItems,
  PINNED_ENVIRONMENT,
  targets,
} from '../../db/schema.ts';
import { configScopeOf } from '../../domain/config.ts';
import {
  type ConfigDocument,
  configVersionOf,
  documentOf,
} from '../../domain/config-version.ts';

/** One (Component, Target) pair's config, as core is allowed to know it. */
export interface PinnedConfig {
  readonly document: ConfigDocument;
  /** §10's hash. Defined for an empty document too — "no config" is a state. */
  readonly version: string;
}

/** Every pinned reference for one (Component, Target), as a hashed document. */
export async function readPinnedConfig(
  db: Database,
  componentId: string,
  targetId: string,
): Promise<PinnedConfig> {
  const rows = await db
    .select({
      key: configItems.key,
      storeRef: configItems.storeRef,
      storeVersion: configItems.storeVersion,
    })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        eq(configItems.kind, 'secret_ref'),
      ),
    );

  const document = documentOf(rows);
  return { document, version: await configVersionOf(document) };
}

/**
 * The names a store scopes an item by, resolved from ids (§10).
 *
 * The scope is Spindrift's, not the store's: how it becomes an item name is the
 * adapter's business, which is what lets one vault back several Targets.
 */
export async function configScopeFor(
  db: Database,
  componentId: string,
  targetId: string,
): Promise<ConfigScope | null> {
  const [row] = await db
    .select({
      app: apps.name,
      component: components.name,
      target: targets.name,
    })
    .from(components)
    .innerJoin(apps, eq(components.appId, apps.id))
    .innerJoin(targets, eq(targets.id, targetId))
    .where(eq(components.id, componentId));

  return row === undefined ? null : configScopeOf(row);
}
