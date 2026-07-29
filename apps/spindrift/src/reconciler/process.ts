/**
 * The reconciler process (§19).
 *
 * Individual loops own one kind of reconciliation. This module owns their
 * shared lifecycle: start them together, isolate failures, retry a failed loop
 * with bounded backoff, and stop every loop from one signal.
 */
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { DEFAULT_REAP_INTERVAL_MS, runConfigLoop } from './config-loop.ts';
import {
  DEFAULT_INTERVALS,
  type LoopIntervals,
  runDeployLoop,
} from './deploy-loop.ts';
import { runRepoLoop } from './repo-loop.ts';
import { runTargetLoop } from './target-loop.ts';

export type ReconcilerLoopName = 'target' | 'repository' | 'config' | 'deploy';

/** One independently supervised process loop. */
export interface SupervisedLoop {
  readonly name: ReconcilerLoopName;
  run(signal: AbortSignal): Promise<void>;
}

/** Bounded exponential retry after a loop-level failure. */
export interface RetryBackoff {
  readonly initialMs: number;
  readonly maximumMs: number;
  readonly multiplier: number;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoff = {
  initialMs: 1_000,
  maximumMs: 60_000,
  multiplier: 2,
};

export interface LoopFailure {
  readonly loop: ReconcilerLoopName;
  readonly cause: unknown;
  readonly retryInMs: number;
}

export interface SupervisorOptions {
  readonly signal: AbortSignal;
  readonly retry?: RetryBackoff;
  readonly onFailure?: (failure: LoopFailure) => void;
}

/** Everything the long-running process needs after production bootstraps it. */
export interface ReconcilerContext {
  readonly db: Database;
  readonly adapters: AdapterRegistry;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
}

export interface ReconcilerIntervals {
  readonly targetMs?: number;
  readonly repositoryMs?: number;
  readonly configMs?: number;
  readonly deploy?: Partial<LoopIntervals>;
}

export const DEFAULT_TARGET_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_REPOSITORY_INTERVAL_MS = 5 * 60_000;

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
  readonly intervals?: ReconcilerIntervals;
  readonly retry?: RetryBackoff;
  readonly onEvent?: (event: ReconcilerProcessEvent) => void;
}

/**
 * Supervise every loop until shutdown.
 *
 * Each loop gets its own retry chain. `Promise.all` is safe here because those
 * chains absorb and report their own failures; one failed loop therefore
 * cannot reject the aggregate and silently stop its siblings.
 */
export async function superviseLoops(
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

  const store = context.adapters.store(context.manifest.secretStore.adapter);
  if (store === null) {
    throw new Error(
      `the installation has no ${context.manifest.secretStore.adapter} store adapter for config retention`,
    );
  }

  const targetInterval =
    options.intervals?.targetMs ?? DEFAULT_TARGET_INTERVAL_MS;
  const repositoryInterval =
    options.intervals?.repositoryMs ?? DEFAULT_REPOSITORY_INTERVAL_MS;
  const configInterval =
    options.intervals?.configMs ?? DEFAULT_REAP_INTERVAL_MS;
  const deployIntervals: LoopIntervals = {
    ...DEFAULT_INTERVALS,
    ...options.intervals?.deploy,
  };
  const passed = (loop: ReconcilerLoopName): void =>
    options.onEvent?.({ type: 'pass', loop });

  const loops: SupervisedLoop[] = [
    {
      name: 'target',
      run: (signal) =>
        runTargetLoop(context, {
          intervalMs: targetInterval,
          signal,
          onPass: () => passed('target'),
        }),
    },
    {
      name: 'config',
      run: (signal) =>
        runConfigLoop(
          { db: context.db, store },
          {
            intervalMs: configInterval,
            signal,
            onPass: () => passed('config'),
          },
        ),
    },
    {
      name: 'deploy',
      run: (signal) =>
        runDeployLoop(context, {
          intervals: deployIntervals,
          signal,
          onPass: () => passed('deploy'),
        }),
    },
  ];

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
            intervalMs: repositoryInterval,
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
