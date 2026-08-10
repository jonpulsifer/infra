/**
 * The bosun build route.
 *
 * Bosun is a warm-pool microVM runner daemon — a peer system, not something
 * this process dials. Every other route here reaches out: a workflow
 * dispatch, a cloud API, a Job on a cluster this process already holds a
 * token for. Bosun is the mirror image — an operator-controlled host this
 * process cannot reach, which **long-polls in** over the three
 * shared-secret-authed endpoints `src/web/bosun-route.ts` serves. This route
 * is the far side of that: it writes an intent to the outbox
 * (`src/storage/build-outbox.ts`) and polls the same row for a verdict,
 * exactly the way every other route here polls a status endpoint — the
 * endpoint just happens to be this installation's own database instead of a
 * far side's API.
 *
 * `ON_COMPLETION`, and it has to be: a bosun host reports nothing until it
 * posts a result, so there is nothing to watch live (§4's fidelity is a
 * property of the runner, and this runner has none of the other two modes'
 * shape).
 */

import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import type {
  BuildAdapter,
  BuildEvent,
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

/** What a finished attempt reports back, exactly as `bosun-route.ts` stores it. */
export interface BosunOutboxResult {
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly log: string;
  readonly detail?: string;
}

/** One outbox row, as much of it as this route reads. */
export interface BosunOutboxState {
  readonly state: 'PENDING' | 'CLAIMED' | 'DONE';
  /**
   * Opaque here rather than typed as {@link BosunOutboxResult}: the outbox
   * table's column is `jsonb`, and the shape was already checked once, by
   * `bosun-route.ts`'s zod schema, on the way in. This route trusts its own
   * database the way every other route trusts the process it just dispatched.
   */
  readonly result: unknown;
}

/**
 * The far side this route drives — the outbox, narrowed to the three verbs a
 * build actually needs. Declared here rather than importing `BuildOutbox`
 * itself, the same reason `ActionsHost` is its own interface in
 * `github-actions.ts`: naming exactly what is needed is what lets a test
 * stand a fake behind this route without building the whole store.
 *
 * `src/storage/build-outbox.ts`'s `buildOutbox()` satisfies this directly —
 * its `enqueue`, `get`, and `cancel` already have this shape.
 */
export interface BosunOutbox {
  enqueue(input: {
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
  /** The zero-config BuildKit frontend the installation pinned (§4). */
  readonly zeroConfigFrontend: string;
  /**
   * The trusted builder identity the build-hull stamps in its statement, as
   * this installation's manifest names it (§20) — see
   * `bosunConfigSchema.provenanceBuilderId` for why it travels as
   * configuration rather than as a constant here.
   */
  readonly provenanceBuilderId: string;
}

export class BosunBuildRoute implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity = 'ON_COMPLETION';
  /**
   * A skiff is an operator-controlled microVM under a daemon this repository
   * cannot reach — the same isolation gap ARC's runner pool carries in this
   * repo's own SLSA charting, and the same rating for the same reason: the
   * operator who controls the host also controls what a build running on it
   * can see.
   */
  readonly buildLevel: BuildLevel = 2;
  readonly provenanceBuilderId: string;
  /**
   * The credential travels inside the claim response body, over the same
   * authed channel every field of the request does, into a skiff's private
   * directory that nothing outside that microVM reads. That is a materially
   * different exposure than `github-actions.ts`'s: there, the danger is
   * GitHub rendering `workflow_dispatch` inputs in a run header anyone with
   * read access to the repository can open, which is why that route seals the
   * credential before it ever reaches the request. Nothing here renders the
   * outbox row anywhere public, so it travels as the other fields do.
   */
  readonly carriesRegistryCredential = true;
  /** A skiff has no ambient registry identity — nothing it pushes to is unaided. */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [];

  constructor(private readonly options: BosunRouteOptions) {
    this.name = options.name;
    this.provenanceBuilderId = options.provenanceBuilderId;
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
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
      },
    };

    const { id } = await outbox.enqueue({ class: this.options.class, request });
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
        // Best-effort: a failed cancel leaves a row a reclaim will eventually
        // return to PENDING, which is stale but not wrong — the Build this
        // route is answering for is already failing either way.
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
      // A DONE row with no result is one this route (or an earlier attempt)
      // gave up on — `cancel`'s own contract. Nothing else writes DONE with a
      // null result.
      return buildFailed(
        logs,
        'INTERNAL',
        `build request ${id} was cancelled before a bosun host reported a result`,
        { id },
      );
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
