/**
 * Runs every reconciler loop under one supervisor: each loop retries its own
 * failures with bounded backoff, and one signal stops them all.
 */
import type { SecretStore } from '../adapters/store/contract.ts';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';
import { dispatchAutoDeploys } from './auto-deploy.ts';
import { DEFAULT_BUILD_INTERVALS, runBuildLoop } from './build-loop.ts';
import { DEFAULT_REAP_INTERVAL_MS, runConfigLoop } from './config-loop.ts';
import {
  DEFAULT_DATASTORE_INTERVAL_MS,
  runDatastoreLoop,
} from './datastore-loop.ts';
import { DEFAULT_INTERVALS, runDeployLoop } from './deploy-loop.ts';
import { runRepoLoop } from './repo-loop.ts';
import { runTargetLoop } from './target-loop.ts';
import { runVesselLoop } from './vessel-loop.ts';

export type ReconcilerLoopName =
  | 'target'
  | 'vessel'
  | 'repository'
  | 'config'
  | 'datastore'
  | 'build'
  | 'deploy'
  | 'manifest';

interface SupervisedLoop {
  readonly name: ReconcilerLoopName;
  run(signal: AbortSignal): Promise<void>;
}

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
 * Loops read `manifest` and `adapters` per pass and never capture them:
 * production supplies getters over the value `refresh` replaces.
 */
export interface ReconcilerContext {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
  /** Absent, the context never changes after startup. */
  readonly refresh?: () => Promise<void>;
}

const DEFAULT_TARGET_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REPOSITORY_INTERVAL_MS = 5 * 60_000;
// Far below the other loops, because the operator who just saved the manifest
// is watching. A tick costs one select when nothing changed.
const DEFAULT_MANIFEST_INTERVAL_MS = 30_000;

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
  readonly manifestIntervalMs?: number;
  readonly onEvent?: (event: ReconcilerProcessEvent) => void;
}

// `Promise.all` cannot reject here: each loop's retry chain absorbs its own
// failures, so one failed loop never stops its siblings.
async function superviseLoops(
  loops: readonly SupervisedLoop[],
  options: SupervisorOptions,
): Promise<void> {
  if (options.signal.aborted) return;
  await Promise.all(loops.map((loop) => superviseLoop(loop, options)));
}

export async function runReconciler(
  context: ReconcilerContext,
  options: ReconcilerOptions,
): Promise<void> {
  if (options.signal.aborted) return;

  // Fails at startup when the installation has no store for config retention.
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
      name: 'vessel',
      run: (signal) =>
        runVesselLoop(context, {
          intervalMs: DEFAULT_TARGET_INTERVAL_MS,
          signal,
          onPass: () => passed('vessel'),
        }),
    },
    {
      name: 'config',
      run: (signal) =>
        runConfigLoop(
          {
            db: context.db,
            // A getter, so each pass uses the store the current manifest names.
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
      name: 'datastore',
      run: (signal) =>
        runDatastoreLoop(context, {
          intervalMs: DEFAULT_DATASTORE_INTERVAL_MS,
          signal,
          onPass: () => passed('datastore'),
        }),
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
    // Supervised, so a database error while re-reading backs off and retries.
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
            // The webhook route calls `dispatchAutoDeploys` too, so a missed
            // delivery still deploys on the next tick.
            onPass: async (passes) => {
              passed('repository');
              await dispatchAutoDeploys(context, passes);
            },
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
