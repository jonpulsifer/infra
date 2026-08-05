/**
 * The reconciler process (§19).
 *
 * Individual loops own one kind of reconciliation. This module owns their
 * shared lifecycle: start them together, isolate failures, retry a failed loop
 * with bounded backoff, and stop every loop from one signal.
 */
import type { SecretStore } from '../adapters/store/contract.ts';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';
import { DEFAULT_BUILD_INTERVALS, runBuildLoop } from './build-loop.ts';
import { DEFAULT_REAP_INTERVAL_MS, runConfigLoop } from './config-loop.ts';
import { DEFAULT_INTERVALS, runDeployLoop } from './deploy-loop.ts';
import { runRepoLoop } from './repo-loop.ts';
import { runTargetLoop } from './target-loop.ts';

export type ReconcilerLoopName =
  | 'target'
  | 'repository'
  | 'config'
  | 'build'
  | 'deploy'
  | 'manifest';

/** One independently supervised process loop. */
interface SupervisedLoop {
  readonly name: ReconcilerLoopName;
  run(signal: AbortSignal): Promise<void>;
}

/** Bounded exponential retry after a loop-level failure. */
export interface RetryBackoff {
  readonly initialMs: number;
  readonly maximumMs: number;
  readonly multiplier: number;
}

const DEFAULT_RETRY_BACKOFF: RetryBackoff = {
  initialMs: 1_000,
  maximumMs: 60_000,
  multiplier: 2,
};

interface LoopFailure {
  readonly loop: ReconcilerLoopName;
  readonly cause: unknown;
  readonly retryInMs: number;
}

interface SupervisorOptions {
  readonly signal: AbortSignal;
  readonly retry?: RetryBackoff;
  readonly onFailure?: (failure: LoopFailure) => void;
}

/**
 * Everything the long-running process needs after production bootstraps it.
 *
 * `manifest` and `adapters` are **read per pass, never captured**. Production
 * supplies them as getters over a value {@link ReconcilerContext.refresh}
 * replaces, so a loop that holds this context for the life of the process still
 * acts on the configuration as it is now. Every loop below already passes this
 * object into its per-pass function rather than destructuring it at startup,
 * which is what makes that work without touching any of them.
 */
export interface ReconcilerContext {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
  /**
   * Re-read the stored manifest and rebuild whatever was assembled from it.
   *
   * Absent leaves the context frozen, which is what a test that supplies its
   * own manifest wants. Production supplies it, because `configureInstallation`
   * writes the row this process would otherwise never re-read — the
   * declared-change-that-does-nothing failure §20's authoring path exists to
   * remove. The web process solves the same problem per request; this process
   * has no request to hang a read on, so it hangs it on a loop.
   */
  readonly refresh?: () => Promise<void>;
}

const DEFAULT_TARGET_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REPOSITORY_INTERVAL_MS = 5 * 60_000;
/**
 * How soon a saved manifest reaches the loops.
 *
 * Far below the loops it feeds, because the operator who just pressed save is
 * watching. One `select` against a row this process already reads at startup,
 * and no adapter is rebuilt unless the document actually changed.
 */
const DEFAULT_MANIFEST_INTERVAL_MS = 30_000;

/** Observable process events for production logging and lifecycle tests. */
export type ReconcilerProcessEvent =
  | {
      readonly type: 'pass';
      readonly loop: ReconcilerLoopName;
    }
  | {
      readonly type: 'disabled';
      readonly loop: 'repository';
      readonly reason: string;
    }
  | ({ readonly type: 'failure' } & LoopFailure);

export interface ReconcilerOptions {
  readonly signal: AbortSignal;
  readonly retry?: RetryBackoff;
  /**
   * How often {@link ReconcilerContext.refresh} runs, for a test that cannot
   * wait {@link DEFAULT_MANIFEST_INTERVAL_MS} to watch a change arrive.
   */
  readonly manifestIntervalMs?: number;
  readonly onEvent?: (event: ReconcilerProcessEvent) => void;
}

/**
 * Supervise every loop until shutdown.
 *
 * Each loop gets its own retry chain. `Promise.all` is safe here because those
 * chains absorb and report their own failures; one failed loop therefore
 * cannot reject the aggregate and silently stop its siblings.
 */
async function superviseLoops(
  loops: readonly SupervisedLoop[],
  options: SupervisorOptions,
): Promise<void> {
  if (options.signal.aborted) return;
  await Promise.all(loops.map((loop) => superviseLoop(loop, options)));
}

/**
 * Compose and run this installation's reconciliation loops.
 *
 * Repository reconciliation is the only optional loop: uploaded archives need
 * no repository integration. Target refresh, config retention, and Deploy
 * convergence are standing responsibilities of every installation.
 */
export async function runReconciler(
  context: ReconcilerContext,
  options: ReconcilerOptions,
): Promise<void> {
  if (options.signal.aborted) return;

  // Once here so an installation that cannot retain config says so at startup
  // rather than on the config loop's first pass, and again per pass below so
  // the store is the one the current manifest names.
  storeFor(context);

  const passed = (loop: ReconcilerLoopName): void =>
    options.onEvent?.({ type: 'pass', loop });

  const loops: SupervisedLoop[] = [
    {
      name: 'target',
      run: (signal) =>
        runTargetLoop(context, {
          intervalMs: DEFAULT_TARGET_INTERVAL_MS,
          signal,
          onPass: () => passed('target'),
        }),
    },
    {
      name: 'config',
      run: (signal) =>
        runConfigLoop(
          {
            db: context.db,
            // A getter, not the value resolved above: `runConfigPass` reads
            // this per pass, and a store captured at startup would be the one
            // the process booted with even after the manifest named another.
            get store() {
              return storeFor(context);
            },
          },
          {
            intervalMs: DEFAULT_REAP_INTERVAL_MS,
            signal,
            onPass: () => passed('config'),
          },
        ),
    },
    {
      name: 'deploy',
      run: (signal) =>
        runDeployLoop(context, {
          intervals: DEFAULT_INTERVALS,
          signal,
          onPass: () => passed('deploy'),
        }),
    },
    {
      name: 'build',
      run: (signal) =>
        runBuildLoop(context, {
          intervals: DEFAULT_BUILD_INTERVALS,
          signal,
          onPass: () => passed('build'),
        }),
    },
  ];

  const refresh = context.refresh;
  if (refresh !== undefined) {
    // Supervised like any other loop rather than raced alongside them: a
    // database blip while re-reading the row is a transient this process
    // already knows how to back off from, not a reason to stop reconciling.
    loops.push({
      name: 'manifest',
      run: async (signal) => {
        const interval =
          options.manifestIntervalMs ?? DEFAULT_MANIFEST_INTERVAL_MS;
        while (!signal.aborted) {
          const startedAt = Date.now();
          await refresh();
          reconcilerLoopDuration.record((Date.now() - startedAt) / 1000, {
            loop: 'manifest',
          });
          if (signal.aborted) return;
          passed('manifest');
          await abortableSleep(interval, signal);
        }
      },
    });
  }

  const repository = context.adapters.repository();
  if (repository === null) {
    options.onEvent?.({
      type: 'disabled',
      loop: 'repository',
      reason: 'this installation has no repository integration',
    });
  } else {
    loops.push({
      name: 'repository',
      run: (signal) =>
        runRepoLoop(
          { db: context.db, clock: context.clock, host: repository },
          {
            intervalMs: DEFAULT_REPOSITORY_INTERVAL_MS,
            signal,
            onPass: () => passed('repository'),
          },
        ),
    });
  }

  await superviseLoops(loops, {
    signal: options.signal,
    ...(options.retry ? { retry: options.retry } : {}),
    onFailure: (failure) => options.onEvent?.({ type: 'failure', ...failure }),
  });
}

/** §10's store of record, as the manifest names it *now*. */
function storeFor(context: ReconcilerContext): SecretStore {
  const store = context.adapters.store(context.manifest.secretStore.adapter);
  if (store === null) {
    throw new Error(
      `the installation has no ${context.manifest.secretStore.adapter} store adapter for config retention`,
    );
  }
  return store;
}

async function superviseLoop(
  loop: SupervisedLoop,
  options: SupervisorOptions,
): Promise<void> {
  const retry = options.retry ?? DEFAULT_RETRY_BACKOFF;
  let retryInMs = retry.initialMs;

  while (!options.signal.aborted) {
    try {
      await loop.run(options.signal);
      if (options.signal.aborted) return;
      throw new Error(`${loop.name} loop stopped before process shutdown`);
    } catch (cause) {
      if (options.signal.aborted) return;
      options.onFailure?.({ loop: loop.name, cause, retryInMs });
      await abortableSleep(retryInMs, options.signal);
      retryInMs = Math.min(
        retry.maximumMs,
        Math.max(retry.initialMs, retryInMs * retry.multiplier),
      );
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
