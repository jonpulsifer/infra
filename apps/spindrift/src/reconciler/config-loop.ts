/**
 * The config retention loop (§10).
 *
 * §10: "**Config lifecycle is a core responsibility** — no store offers a
 * delegate-to-the-registry escape. **Retention N = 10, the same depth as
 * artifacts**: a constraint, not a coincidence, since shallower config makes a
 * rollback come up green and unconfigured. Core reaps on a loop."
 *
 * Three things follow from that sentence and are the whole of this file:
 *
 * - **It is a loop, not a hook on the write.** A `put` that also reaped would
 *   make an act a developer is waiting on wait for a second call to the store,
 *   and would leave a key un-reaped forever the moment somebody stopped setting
 *   it. The write path reaps the key it touched as a fast path; this is what
 *   catches everything else.
 * - **It reaps from the store's own list.** `versions` is newest-first by the
 *   contract, and the store is the only thing that knows which of its items is
 *   newer — a version *number* exists under `NATIVE` pinning and does not under
 *   `IMMUTABLE_ITEM_PER_VERSION`.
 * - **It never touches a row.** Retention is about versions behind a pin, not
 *   about which keys are configured; deleting a `config_items` row here would
 *   be core deciding a variable no longer exists.
 *
 * A store that refuses is not a fault worth stopping for: the next pass tries
 * again, and a key that could not be reaped is a key with more history than
 * intended, which harms nobody.
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
} from '../db/schema.ts';
import { CONFIG_RETENTION, configScopeOf, reapable } from '../domain/config.ts';

/** What the loop needs. No principal: nobody asked for it to run. */
export interface ConfigLoopContext {
  readonly db: Database;
  readonly store: SecretStore;
  /** §10's N, injected so a test does not have to write eleven versions. */
  readonly retention?: number;
}

/** What one pass did, per key it looked at. */
export interface ReapReport {
  readonly componentId: string;
  readonly targetId: string;
  readonly key: string;
  readonly destroyed: number;
}

/** Reap every configured key once. */
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
      target: targets.name,
    })
    .from(configItems)
    .innerJoin(components, eq(configItems.componentId, components.id))
    .innerJoin(apps, eq(components.appId, apps.id))
    .innerJoin(targets, eq(configItems.targetId, targets.id))
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
      // A store that would not answer is not a reason to stop reaping the rest
      // of the installation, and the next pass asks again.
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

/** How often to reap, and how to stop. */
export interface ConfigLoopOptions {
  /**
   * Retention is a depth, not a deadline. Hourly is chosen for what it costs —
   * one `versions` call per configured key — rather than for how quickly an
   * expired version disappears, which nothing is waiting on.
   */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (reports: readonly ReapReport[]) => void;
}

export const DEFAULT_REAP_INTERVAL_MS = 60 * 60_000;

/** Run until aborted. */
export async function runConfigLoop(
  context: ConfigLoopContext,
  options: ConfigLoopOptions = {},
): Promise<void> {
  const interval = options.intervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  while (!options.signal?.aborted) {
    options.onPass?.(await runConfigPass(context));
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
