/**
 * A fake build route (Task 7).
 *
 * § Testing: **"Fake the far side, not our side."** This is the builder that is
 * not there. It records the {@link BuildSource} and {@link BuildSpec} it was
 * handed — so a test can assert that the bundle digest reached the route, which
 * is §16's whole join — and replays a scripted result.
 */
import { createHash } from 'node:crypto';
import type {
  BuildAdapter,
  BuildEvent,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from '../../../src/adapters/build/contract.ts';

/** What the fake was asked to build, in order. */
export interface RecordedBuild {
  source: BuildSource;
  spec: BuildSpec;
}

/** One scripted build: what to yield along the way, and how it ends. */
export interface ScriptedBuild {
  events?: readonly BuildEvent[];
  /**
   * The result, minus the bookkeeping the fake fills in itself: `logs` names
   * this route, and a green build echoes the bundle digest it was given, since
   * a route that cannot do that cannot produce a joinable provenance (§16).
   */
  result:
    | { status: 'SUCCEEDED'; digest?: string; baseDigest?: string | null }
    | {
        status: 'FAILED';
        reason: BuildResultFailure['reason'];
        detail?: string;
      };
}

type BuildResultFailure = Extract<BuildResult, { status: 'FAILED' }>;

export interface FakeBuildAdapterOptions {
  name?: string;
  logFidelity?: LogFidelity;
  buildLevel?: BuildLevel;
  provenanceBuilderId?: string;
  script?: readonly ScriptedBuild[];
}

const DEFAULT_BUILD: ScriptedBuild = { result: { status: 'SUCCEEDED' } };

export class FakeBuildAdapter implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity;
  readonly buildLevel: BuildLevel;
  readonly provenanceBuilderId: string;

  /** Every `build`, in call order. */
  readonly built: RecordedBuild[] = [];

  private readonly script: readonly ScriptedBuild[];
  private builds = 0;

  constructor(options: FakeBuildAdapterOptions = {}) {
    this.name = options.name ?? 'fake';
    this.logFidelity = options.logFidelity ?? 'LIVE_TEXT';
    this.buildLevel = options.buildLevel ?? 2;
    this.provenanceBuilderId =
      options.provenanceBuilderId ?? 'https://spindrift.dev/builders/fake';
    this.script = options.script?.length ? options.script : [DEFAULT_BUILD];
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    this.built.push({ source, spec });

    const scripted = this.nextBuild();
    for (const event of scripted.events ?? []) yield event;

    const logs = { backend: this.name, fidelity: this.logFidelity } as const;

    if (scripted.result.status === 'FAILED') {
      return {
        status: 'FAILED',
        artifact: null,
        logs,
        provenance: null,
        baseDigest: null,
        buildkitProvenanceRef: null,
        sbomRef: null,
        reason: scripted.result.reason,
        ...(scripted.result.detail === undefined
          ? {}
          : { detail: scripted.result.detail }),
      };
    }

    return {
      status: 'SUCCEEDED',
      artifact: {
        type: spec.artifactType,
        digest: scripted.result.digest ?? `sha256:${this.name}-${this.builds}`,
        refs: [`${spec.destination}@${scripted.result.digest ?? 'fake'}`],
      },
      logs,
      provenance: {
        // Echoed, never invented: this is the join §16 asks a route for.
        bundleDigest: source.bundleDigest,
        claimedLevel: this.buildLevel,
        statement: { fake: true },
      },
      baseDigest: scripted.result.baseDigest ?? null,
      buildkitProvenanceRef: `${spec.destination}@${scripted.result.digest ?? 'fake'}#buildkit`,
      sbomRef: `${spec.destination}@${scripted.result.digest ?? 'fake'}#spdx`,
    };
  }

  /** The last scripted build repeats once the script is exhausted. */
  private nextBuild(): ScriptedBuild {
    const index = Math.min(this.builds, this.script.length - 1);
    this.builds += 1;
    return this.script[index] ?? DEFAULT_BUILD;
  }
}
