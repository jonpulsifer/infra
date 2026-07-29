/**
 * The `reconciler` process (§19) — production entrypoint.
 *
 * Postgres owns the installation manifest after bootstrap. The process reads
 * that stored document, constructs exactly that installation's adapters, and
 * gives all four polling loops one lifecycle without giving any loop the power
 * to stop its siblings.
 */
import type { ReconcilerProcessEvent } from './process.ts';
import { startReconciler } from './start.ts';

const shutdown = new AbortController();
const stop = (): void => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await startReconciler({
    signal: shutdown.signal,
    onStarted: (manifest) =>
      console.log(`spindrift reconciler → running (${manifest.installation})`),
    onEvent: report,
  });
} finally {
  shutdown.abort();
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
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
