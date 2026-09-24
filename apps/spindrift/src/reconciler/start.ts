/**
 * Production bootstrap for the reconciler process. Kept out of `main.ts` so a
 * test can start it without installing signal handlers.
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
  /** The caller owns a supplied client; this closes only one it created. */
  readonly client?: SQL;
  readonly clock?: Clock;
  /** Injected for tests; production builds the registry from the manifest. */
  readonly createAdapters?: (manifest: InstallationManifest) => AdapterRegistry;
  readonly onStarted?: (manifest: InstallationManifest) => void;
  readonly onEvent?: (event: ReconcilerProcessEvent) => void;
  readonly manifestIntervalMs?: number;
}

import { initTelemetry } from '../telemetry/index.ts';

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

    // `loadStoredManifest` seeds and reconciles, so it runs once; refresh reads
    // with `currentStoredManifest`, which needs no transaction.
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
        // Getters, so long-lived loops see what `refresh` last assembled.
        // Adapters bake in manifest values such as `supplyChain.signer`.
        get manifest() {
          return current.manifest;
        },
        get adapters() {
          return current.adapters;
        },
        refresh: async () => {
          const stored = await currentStoredManifest(db, env);
          // Reassembled only on change: an unchanged installation costs one
          // select per tick.
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
