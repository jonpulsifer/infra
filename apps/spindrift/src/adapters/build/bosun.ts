/**
 * The bosun build route. Bosun hosts long-poll in through
 * `src/web/bosun-route.ts`, so this route writes an intent to the build outbox
 * and polls that row for a verdict.
 */

import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import type {
  BuildAdapter,
  BuildEvent,
  BuildHandle,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from './contract.ts';
import type { BuildRouteDescriptor } from './descriptor.ts';
import { parseBuildReport } from './report.ts';
import {
  buildFailed,
  buildSucceeded,
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

/** A finished attempt's result, as `bosun-route.ts` stores it. */
export interface BosunOutboxResult {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly log: string;
  readonly detail?: string;
}

export interface BosunOutboxState {
  readonly state: 'PENDING' | 'CLAIMED' | 'DONE';
  /** Untyped here: `bosun-route.ts` validated it with zod before storing it. */
  readonly result: unknown;
}

/**
 * The outbox verbs this route uses. `buildOutbox()` in
 * `src/storage/build-outbox.ts` satisfies it.
 */
export interface BosunOutbox {
  enqueue(input: {
    /** Omitted, the outbox mints one. */
    readonly id?: string;
    readonly class: string;
    readonly request: unknown;
  }): Promise<{ readonly id: string }>;
  get(id: string): Promise<BosunOutboxState | null>;
  cancel(id: string): Promise<void>;
}

export interface BosunRouteOptions extends PollingOptions {
  readonly name: string;
  /** The skiff pool this route enqueues onto. */
  readonly class: string;
  readonly outbox: BosunOutbox;
  readonly zeroConfigFrontend: string;
  /** Configured, because it names this installation's own bosun host. */
  readonly provenanceBuilderId: string;
}

export class BosunBuildRoute implements BuildAdapter {
  readonly name: string;
  /** A bosun host reports nothing until it posts its result. */
  readonly logFidelity: LogFidelity = 'ON_COMPLETION';
  /** L2: the operator of a bosun host can reach any build running on it. */
  readonly buildLevel: BuildLevel = 2;
  readonly provenanceBuilderId: string;
  /**
   * Secrets travel in the authenticated claim response, and nothing renders the
   * outbox row publicly.
   */
  readonly carriesHeldSecret = true;
  /** A skiff has no registry identity of its own. */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [];

  constructor(private readonly options: BosunRouteOptions) {
    this.name = options.name;
    this.provenanceBuilderId = options.provenanceBuilderId;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
    dispatchId?: string,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;
    const { outbox } = this.options;

    const request = {
      source,
      spec: {
        artifactType: spec.artifactType,
        kind: spec.kind,
        platform: spec.platform,
        destinations: spec.destinations,
        tags: spec.tags,
        buildArgs: spec.buildArgs,
        zeroConfigFrontend: this.options.zeroConfigFrontend,
        registryAuth: spec.registryAuth,
        // The hull writes each secret to a file and hands `docker buildx` the mounts.
        buildSecrets: spec.buildSecrets,
      },
    };

    // Named by the dispatch id so `cancel` can find the row from the Build row
    // alone; without one the outbox mints an id.
    const { id } = await outbox.enqueue({
      ...(dispatchId === undefined ? {} : { id: dispatchId }),
      class: this.options.class,
      request,
    });
    yield {
      type: 'log',
      at: now(),
      line: `enqueued on bosun class “${this.options.class}” as ${id}`,
    };

    const budget = deadlineFrom(this.options);
    let claimed = false;
    let row: BosunOutboxState | null = null;

    for (;;) {
      row = await outbox.get(id);
      if (row === null) {
        return buildFailed(
          logs,
          'INTERNAL',
          `the outbox lost track of build request ${id}`,
          { id },
        );
      }
      if (row.state === 'DONE') break;
      if (row.state === 'CLAIMED' && !claimed) {
        claimed = true;
        yield { type: 'log', at: now(), line: 'claimed by the pool' };
      }

      if (budget.expired()) {
        // Best-effort: the Build fails either way.
        await outbox.cancel(id).catch(() => {});
        return buildFailed(
          logs,
          claimed ? 'TIMEOUT' : 'TARGET_UNREACHABLE',
          claimed
            ? `request ${id} was claimed but did not finish within the build budget`
            : `no bosun host claimed request ${id} within the build budget`,
          { id },
        );
      }
      await budget.tick();
    }

    const result = row.result as BosunOutboxResult | null;
    if (result === null) {
      // Only `cancel` writes DONE with no result, on this route's budget or for
      // an operator. `TIMEOUT` is the reason that blames nobody.
      const ending = `build request ${id} was cancelled before a bosun host reported a result`;
      yield { type: 'log', at: now(), line: ending };
      return buildFailed(logs, 'TIMEOUT', ending, { id });
    }

    for (const line of result.log.split('\n')) {
      if (line.trim() === '') continue;
      yield { type: 'log', at: now(), line };
    }

    if (result.status === 'FAILED') {
      return buildFailed(logs, 'BUILD_FAILED', result.detail, { id });
    }

    const report = parseBuildReport(result.log);
    if (report === null) {
      return buildFailed(
        logs,
        'INTERNAL',
        `build request ${id} succeeded but reported no artifact`,
        { id },
      );
    }

    return buildSucceeded({
      source,
      spec,
      logs,
      level: this.buildLevel,
      report,
    });
  }

  /** The claiming host kills the skiff when its next heartbeat is refused. */
  cancel(handle: BuildHandle): Promise<void> {
    return this.options.outbox.cancel(handle.dispatchId);
  }
}

import { bosunConfigSchema } from '../../config/build-route-schemas.ts';

export const bosunDescriptor = {
  kind: 'bosun',
  displayName: 'bosun',
  logo: 'nixos',
  buildLevel: 2,
  configSchema: bosunConfigSchema,
  create(config, context) {
    if (!context.outbox) return null;
    return new BosunBuildRoute({
      name: config.name,
      class: config.class,
      outbox: context.outbox,
      zeroConfigFrontend: context.manifest.build.zeroConfigFrontend,
      provenanceBuilderId: config.provenanceBuilderId,
    });
  },
} satisfies BuildRouteDescriptor;
