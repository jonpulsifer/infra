/** A `BuildAdapter` that records each build and replays a scripted result. */

import { createHash } from 'node:crypto';
import type {
  BuildAdapter,
  BuildEvent,
  BuildHandle,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from '../../../src/adapters/build/contract.ts';
import type { RegistryFlavour } from '../../../src/domain/artifact-name.ts';

export interface RecordedBuild {
  source: BuildSource;
  spec: BuildSpec;
  /** `null` when the route is called without a dispatch id. */
  dispatchId: string | null;
}

export interface ScriptedBuild {
  events?: readonly BuildEvent[];
  /** The fake adds `logs`, and a success echoes the bundle digest. */
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
  carriesHeldSecret?: boolean;
  selfAuthorizedRegistries?: readonly RegistryFlavour[];
  script?: readonly ScriptedBuild[];
}

const DEFAULT_BUILD: ScriptedBuild = { result: { status: 'SUCCEEDED' } };

export class FakeBuildAdapter implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity;
  readonly buildLevel: BuildLevel;
  readonly provenanceBuilderId: string;
  readonly carriesHeldSecret: boolean;
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[];

  readonly built: RecordedBuild[] = [];
  readonly cancelled: BuildHandle[] = [];

  private readonly script: readonly ScriptedBuild[];
  private builds = 0;

  constructor(options: FakeBuildAdapterOptions = {}) {
    this.name = options.name ?? 'fake';
    this.logFidelity = options.logFidelity ?? 'LIVE_TEXT';
    this.buildLevel = options.buildLevel ?? 2;
    this.provenanceBuilderId =
      options.provenanceBuilderId ?? 'https://spindrift.dev/builders/fake';
    this.carriesHeldSecret = options.carriesHeldSecret ?? true;
    this.selfAuthorizedRegistries = options.selfAuthorizedRegistries ?? [
      'artifactRegistry',
      'dockerHub',
      'ghcr',
      'other',
    ];
    this.script = options.script?.length ? options.script : [DEFAULT_BUILD];
  }

  async cancel(handle: BuildHandle): Promise<void> {
    this.cancelled.push(handle);
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
    dispatchId?: string,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    this.built.push({ source, spec, dispatchId: dispatchId ?? null });

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

    const digest =
      scripted.result.digest ?? fakeDigest(`${this.name}-${this.builds}`);

    return {
      status: 'SUCCEEDED',
      artifact: {
        type: spec.artifactType,
        digest,
        refs: [`${spec.destinations[0]}@${digest}`],
      },
      logs,
      provenance: {
        // Verification joins the artifact to its source on this digest.
        bundleDigest: source.bundleDigest,
        claimedLevel: this.buildLevel,
        statement: fakeStatement({
          builderId: this.provenanceBuilderId,
          bundleDigest: source.bundleDigest,
          destination: spec.destinations[0] ?? '',
          digest,
        }),
      },
      baseDigest: scripted.result.baseDigest ?? null,
      buildkitProvenanceRef: `${spec.destinations[0]}@${digest}#buildkit`,
      sbomRef: `${spec.destinations[0]}@${digest}#spdx`,
    };
  }

  /** The last scripted build repeats once the script is exhausted. */
  private nextBuild(): ScriptedBuild {
    const index = Math.min(this.builds, this.script.length - 1);
    this.builds += 1;
    return this.script[index] ?? DEFAULT_BUILD;
  }
}

/** A deterministic digest that passes `DIGEST_PATTERN`. */
export function fakeDigest(label: string): string {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

/**
 * An in-toto v1 statement with the bundle digest at the path `SlsaVerifier` and
 * `apps/spindrift-verifier` read it from.
 */
export function fakeStatement(input: {
  builderId: string;
  bundleDigest: string;
  destination: string;
  digest: string;
}): unknown {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: input.destination,
        digest: { sha256: input.digest.replace(/^sha256:/, '') },
      },
    ],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://spindrift.dev/buildkit/v1',
        externalParameters: { bundleDigest: input.bundleDigest },
      },
      runDetails: { builder: { id: input.builderId } },
    },
  };
}
