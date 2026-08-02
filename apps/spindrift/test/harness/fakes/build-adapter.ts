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
  /** Defaults to true; a test asserting the hosted route's refusal sets false. */
  carriesRegistryCredential?: boolean;
  script?: readonly ScriptedBuild[];
}

const DEFAULT_BUILD: ScriptedBuild = { result: { status: 'SUCCEEDED' } };

export class FakeBuildAdapter implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity;
  readonly buildLevel: BuildLevel;
  readonly provenanceBuilderId: string;
  readonly carriesRegistryCredential: boolean;

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
    this.carriesRegistryCredential = options.carriesRegistryCredential ?? true;
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
        // Echoed, never invented: this is the join §16 asks a route for.
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

/**
 * A digest the product would accept.
 *
 * `sha256:fake-0` was the old default, and three places in `src/` validate a
 * digest against `^sha256:[0-9a-f]{64}$` — so every command test that ran a
 * build through to a Deploy ran on an artifact the real system cannot produce
 * and would refuse. Hashing the label keeps it deterministic and readable in a
 * diff while being a real digest.
 */
export function fakeDigest(label: string): string {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

/**
 * The provenance document a route reports (§16).
 *
 * `{ fake: true }` was here, and it made the verification chain vacuous: the
 * real {@link import('../../../src/supply-chain/verify.ts').SlsaVerifier} reads
 * the *verified envelope* for `predicate.buildDefinition.externalParameters
 * .bundleDigest` and refuses when it does not name the source bundle. A
 * statement without that path fails that check, so nothing that ran against the
 * old value was ever asserting the join §16 is built on.
 *
 * The shape is an in-toto v1 statement because that is what the pinned verifier
 * parses — subject digest, builder id, and bundle digest all live where
 * `apps/spindrift-verifier/pkg/verifier/verify.go` looks for them.
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
