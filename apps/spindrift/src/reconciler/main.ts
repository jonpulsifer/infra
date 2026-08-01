/**
 * The `reconciler` process (§19) — production entrypoint.
 *
 * The deployment declaration reconciles into Postgres before this process
 * constructs exactly that installation's adapters. It then gives all four
 * polling loops one lifecycle without giving any loop the power to stop its
 * siblings.
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

import {
  logError,
  logInfo,
  logWarn,
  reconcilerErrorCounter,
  reconcilerLoopCounter,
} from '../telemetry/index.ts';

function report(event: ReconcilerProcessEvent): void {
  if (event.type === 'failure') {
    reconcilerErrorCounter.add(1, { loop: event.loop });
    logError(
      `spindrift reconciler → ${event.loop} loop failed; retrying in ${event.retryInMs}ms`,
      event.cause,
      { loop: event.loop, retryInMs: event.retryInMs },
    );
  } else if (event.type === 'disabled') {
    logWarn(
      `spindrift reconciler → ${event.loop} loop disabled: ${event.reason}`,
      { loop: event.loop, reason: event.reason },
    );
  } else {
    reconcilerLoopCounter.add(1, { loop: event.loop });
    logInfo(`spindrift reconciler → ${event.loop} loop processed event`, {
      loop: event.loop,
    });
  }
}
