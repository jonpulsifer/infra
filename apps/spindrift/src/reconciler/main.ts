/**
 * The `reconciler` process (§19) — production entrypoint.
 *
 * Postgres owns the installation manifest after bootstrap. The process reads
 * that stored document, constructs exactly that installation's adapters, and
 * gives all four polling loops one lifecycle without giving any loop the power
 * to stop its siblings.
 */
import { createAdapterRegistry } from '../adapters/registry.ts';
import { systemClock } from '../commands/types.ts';
import { loadStoredManifest } from '../config/manifest-store.ts';
import { createClient, createDb } from '../db/client.ts';
import { type ReconcilerProcessEvent, runReconciler } from './process.ts';

const shutdown = new AbortController();
const stop = (): void => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const client = createClient();
try {
  const db = createDb(client);
  const manifest = await loadStoredManifest(db);
  const adapters = createAdapterRegistry({ manifest });

  console.log(`spindrift reconciler → running (${manifest.installation})`);
  await runReconciler(
    { db, adapters, clock: systemClock, manifest },
    { signal: shutdown.signal, onEvent: report },
  );
} finally {
  shutdown.abort();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  await client.close();
}

function report(event: ReconcilerProcessEvent): void {
  if (event.type === 'failure') {
    console.error(
      `spindrift reconciler → ${event.loop} loop failed; retrying in ${event.retryInMs}ms`,
      event.cause,
    );
  } else if (event.type === 'disabled') {
    console.log(
      `spindrift reconciler → ${event.loop} loop disabled: ${event.reason}`,
    );
  }
}
