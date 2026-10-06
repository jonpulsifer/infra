/**
 * Reads a Component@Target's config as a pinned document and its version. It
 * selects keys and pins only, never values; deploys record this version.
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
  vessels,
} from '../../db/schema.ts';
import { configScopeOf } from '../../domain/config.ts';
import {
  type ConfigDocument,
  configVersionOf,
  documentOf,
} from '../../domain/config-version.ts';

export interface PinnedConfig {
  readonly document: ConfigDocument;
  /** Defined for an empty document too. */
  readonly version: string;
}

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

/** Null when the Component or Target does not exist. */
export async function configScopeFor(
  db: Database,
  componentId: string,
  targetId: string,
): Promise<ConfigScope | null> {
  const [row] = await db
    .select({
      app: apps.name,
      component: components.name,
      vessel: vessels.name,
      adapter: targets.adapter,
    })
    .from(components)
    .innerJoin(apps, eq(components.appId, apps.id))
    .innerJoin(targets, eq(targets.id, targetId))
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(components.id, componentId));

  return row === undefined ? null : configScopeOf(row);
}
