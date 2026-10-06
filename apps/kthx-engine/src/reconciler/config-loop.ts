/**
 * Reaps each config key's store versions beyond the retention depth. Reads the
 * store's own newest-first list, and never deletes a `config_items` row.
 */
import { eq } from 'drizzle-orm';
import type { SecretStore } from '../adapters/store/contract.ts';
import type { Database } from '../db/client.ts';
import {
  apps,
  components,
  configItems,
  PINNED_ENVIRONMENT,
  targets,
  vessels,
} from '../db/schema.ts';
import { CONFIG_RETENTION, configScopeOf, reapable } from '../domain/config.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';

export interface ConfigLoopContext {
  readonly db: Database;
  readonly store: SecretStore;
  readonly retention?: number;
}

export interface ReapReport {
  readonly componentId: string;
  readonly targetId: string;
  readonly key: string;
  readonly destroyed: number;
}

export async function runConfigPass(
  context: ConfigLoopContext,
): Promise<readonly ReapReport[]> {
  const retention = context.retention ?? CONFIG_RETENTION;
  const rows = await context.db
    .select({
      componentId: configItems.componentId,
      targetId: configItems.targetId,
      key: configItems.key,
      app: apps.name,
      component: components.name,
      vessel: vessels.name,
      adapter: targets.adapter,
    })
    .from(configItems)
    .innerJoin(components, eq(configItems.componentId, components.id))
    .innerJoin(apps, eq(components.appId, apps.id))
    .innerJoin(targets, eq(configItems.targetId, targets.id))
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(configItems.environment, PINNED_ENVIRONMENT));

  const reports: ReapReport[] = [];
  for (const row of rows) {
    const scope = configScopeOf(row);
    let destroyed = 0;
    try {
      for (const version of reapable(
        await context.store.versions(scope, row.key),
        retention,
      )) {
        await context.store.destroy(version.reference);
        destroyed += 1;
      }
    } catch {
      // A refusing store skips this key; the next pass retries it.
      continue;
    }
    reports.push({
      componentId: row.componentId,
      targetId: row.targetId,
      key: row.key,
      destroyed,
    });
  }
  return reports;
}

export interface ConfigLoopOptions {
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (reports: readonly ReapReport[]) => void;
}

// Hourly: a pass costs one `versions` call per configured key, and nothing
// waits on a reap.
export const DEFAULT_REAP_INTERVAL_MS = 60 * 60_000;

export async function runConfigLoop(
  context: ConfigLoopContext,
  options: ConfigLoopOptions = {},
): Promise<void> {
  const interval = options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    const reports = await runConfigPass(context);
    reconcilerLoopDuration.record((Date.now() - startedAt) / 1000, {
      loop: 'config',
    });
    options.onPass?.(reports);
    if (options.signal?.aborted) return;
    await sleep(interval, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
