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
import {
  currentStoredManifest,
  loadStoredManifest,
} from '../config/manifest-store.ts';
import { createClient, createDb } from '../db/client.ts';
import { type ReconcilerProcessEvent, runReconciler } from './process.ts';
import { restoreDeclaredTargetConnections } from './target-loop.ts';

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
  /** Forwarded to the manifest loop; production takes its default. */
  readonly manifestIntervalMs?: number;
}

import { initTelemetry } from '../telemetry/index.ts';

/**
 * Load durable installation state, construct adapters, and run until shutdown.
 */
export async function startReconciler(
  options: StartReconcilerOptions,
): Promise<void> {
  initTelemetry('reconciler');

  const env = options.env ?? Bun.env;
  const ownedClient = options.client === undefined;
  const client = options.client ?? createClient(env);

  try {
    const db = createDb(client);
    const clock = options.clock ?? systemClock;
    const assemble = (manifest: InstallationManifest) => ({
      manifest,
      adapters:
        options.createAdapters?.(manifest) ??
        createAdapterRegistry({ manifest, env, db, clock }),
    });

    /**
     * The configuration the loops run against, current as of the last refresh.
     *
     * `loadStoredManifest` seeds and reconciles, so it runs once at startup;
     * every read after it is `currentStoredManifest`, which the manifest store
     * exports for exactly this — asking whether configuration changed without
     * paying for a transaction to answer.
     */
    let current = assemble(await loadStoredManifest(db, env));

    await restoreDeclaredTargetConnections(
      { db, adapters: current.adapters, clock },
      current.manifest,
    );
    options.onStarted?.(current.manifest);

    await runReconciler(
      {
        db,
        clock,
        // Getters, so a loop holding this object for the life of the process
        // reads what `refresh` last put in `current` rather than what the
        // process booted with. The adapters are the half that matters: the
        // build route bakes in `supplyChain.signer` and `attestor` at
        // assembly, which is how a Build went out naming an attestor added to
        // the manifest minutes earlier and skipped the step on the empty value.
        get manifest() {
          return current.manifest;
        },
        get adapters() {
          return current.adapters;
        },
        refresh: async () => {
          const stored = await currentStoredManifest(db, env);
          // Rebuilt only where the document actually changed, so an unchanged
          // installation costs one `select` per tick and nothing else.
          if (stored === null || Bun.deepEquals(stored, current.manifest, true))
            return;
          current = assemble(stored);
        },
      },
      {
        signal: options.signal,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        ...(options.manifestIntervalMs === undefined
          ? {}
          : { manifestIntervalMs: options.manifestIntervalMs }),
      },
    );
  } finally {
    if (ownedClient) await client.close();
  }
}
