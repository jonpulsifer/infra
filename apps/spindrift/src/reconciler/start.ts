/**
 * Production bootstrap for the reconciler process.
 *
 * Kept out of `main.ts` so startup can be integration-tested without importing
 * a module that installs process signal handlers as a side effect.
 */
import type { SQL } from 'bun';
import { createAdapterRegistry } from '../adapters/registry.ts';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import { systemClock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import { loadStoredManifest } from '../config/manifest-store.ts';
import { createClient, createDb } from '../db/client.ts';
import { type ReconcilerProcessEvent, runReconciler } from './process.ts';

type Env = Record<string, string | undefined>;

export interface StartReconcilerOptions {
  readonly signal: AbortSignal;
  readonly env?: Env;
  /**
   * A caller-supplied client is already owned by that caller. Production omits
   * it and this function closes the client it creates during shutdown.
   */
  readonly client?: SQL;
  readonly clock?: Clock;
  /** Far-side seam for integration tests; production constructs the registry. */
  readonly createAdapters?: (manifest: InstallationManifest) => AdapterRegistry;
  readonly onStarted?: (manifest: InstallationManifest) => void;
  readonly onEvent?: (event: ReconcilerProcessEvent) => void;
}

/**
 * Load durable installation state, construct adapters, and run until shutdown.
 */
export async function startReconciler(
  options: StartReconcilerOptions,
): Promise<void> {
  const env = options.env ?? Bun.env;
  const ownedClient = options.client === undefined;
  const client = options.client ?? createClient(env);

  try {
    const db = createDb(client);
    const manifest = await loadStoredManifest(db, env);
    const adapters =
      options.createAdapters?.(manifest) ??
      createAdapterRegistry({ manifest, env });
    options.onStarted?.(manifest);

    await runReconciler(
      {
        db,
        adapters,
        clock: options.clock ?? systemClock,
        manifest,
      },
      {
        signal: options.signal,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      },
    );
  } finally {
    if (ownedClient) await client.close();
  }
}
