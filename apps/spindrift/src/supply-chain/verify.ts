/**
 * Verification of a build backend's SLSA provenance (§16).
 *
 * The build adapter reports evidence; it does not assess itself. This module is
 * the process boundary around the pinned `slsa-verifier` binary and returns the
 * normalized facts core may persist after that binary accepts the envelope.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BuildLevel,
  BuildProvenance,
  BuildSource,
} from '../adapters/build/contract.ts';
import type { Artifact } from '../domain/desired-state.ts';

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The native process seam; tests replace the far side, never this module. */
export interface ProcessExecutor {
  run(command: readonly string[]): Promise<ProcessResult>;
}

/**
 * The reference that pins an artifact to its digest, whatever it is made of.
 *
 * `immutableImageRef` is the deploy side's version of this and gates on
 * `type === 'image'`, which is right there — a workload needs an image. It is
 * wrong here. §16 says core "signs that digest", and the digest of a `files`
 * artifact is as signable as an image's; the property this module needs is only
 * that the reference names the digest rather than a tag, which is what closes
 * the check/use race the verifier's own contract warns about. Gating on image
 * meant every static-site build was refused before the verifier was spawned.
 */
export function digestPinnedRef(artifact: Artifact): string | null {
  return (
    artifact.refs.find((ref) => ref.endsWith(`@${artifact.digest}`)) ?? null
  );
}

/** Execute one pinned tool without a shell. */
export const bunProcessExecutor: ProcessExecutor = {
  async run(command) {
    const child = Bun.spawn([...command], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: Bun.env,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  },
};

/** Facts copied out of evidence core successfully assessed. */
export interface BackendProvenanceAssessment {
  readonly artifactDigest: string;
  readonly bundleDigest: string;
  readonly backend: string;
  readonly builderId: string;
  readonly slsaVersion: string;
  readonly achievedLevel: BuildLevel;
  readonly verifiedAt: string;
  /** The durable envelope, not only the normalized summary. */
  readonly envelope: unknown;
}

export interface VerifyProvenanceInput {
  readonly artifact: Artifact;
  readonly provenance: BuildProvenance;
  readonly backend: string;
  /** Trusted expectation from the route profile, never from the envelope. */
  readonly expectedBuilderId: string;
  /** The strongest claim this code-defined route profile permits. */
  readonly maximumLevel: BuildLevel;
  readonly source: BuildSource;
}

export type ProvenanceRefusalCode = 'PROVENANCE_MISSING' | 'PROVENANCE_INVALID';

export type ProvenanceVerification =
  | { readonly ok: true; readonly assessment: BackendProvenanceAssessment }
  | {
      readonly ok: false;
      readonly code: ProvenanceRefusalCode;
      readonly message: string;
    };

export interface ProvenanceVerifier {
  verify(input: VerifyProvenanceInput): Promise<ProvenanceVerification>;
}

export interface SlsaVerifierOptions {
  readonly executable?: string;
  readonly processes?: ProcessExecutor;
  readonly now?: () => Date;
}

/**
 * The production verifier.
 *
 * It verifies an immutable reference and a copied envelope. No tag reaches the
 * tool, closing the check/use race the verifier's own contract warns about.
 *
 * **Two limitations of the `verify-image` path, recorded rather than hidden.**
 * `apps/spindrift-verifier/main.go` builds that path's request with
 * `ClaimedLevel: 2`, `MinimumLevel: 1`, `MaximumLevel: 2` and
 * `Backend: "hosted"` hardcoded, and nothing on the command line conveys any of
 * them:
 *
 * 1. *The level is decided here, not there.* Those constants make the binary's
 *    own level arithmetic inert on this path — `min(2, 2) = 2 >= 1` always
 *    passes — so the achieved level is entirely {@link lowerLevel} below,
 *    against the route profile's ceiling. That matches §16 ("guarantees belong
 *    to code-defined backend/runner profiles"), but it does mean an L3 claim
 *    rests on {@link CloudBuildRoute}'s constant and on nothing the envelope
 *    says. Passing the level through would need a flag on both sides and a new
 *    verifier image; it would not change any verdict today.
 * 2. *`--source-uri` is accepted and ignored.* `Expectations.SourceURI` is
 *    declared in `pkg/verifier/types.go` and never read by `Verify`, so the
 *    only source binding anything checks is {@link bundleDigestOf} below.
 */
export class SlsaVerifier implements ProvenanceVerifier {
  private readonly executable: string;
  private readonly processes: ProcessExecutor;
  private readonly now: () => Date;

  constructor(options: SlsaVerifierOptions = {}) {
    this.executable = options.executable ?? 'spindrift-verifier';
    this.processes = options.processes ?? bunProcessExecutor;
    this.now = options.now ?? (() => new Date());
  }

  async verify(input: VerifyProvenanceInput): Promise<ProvenanceVerification> {
    if (input.provenance.statement === null) {
      return {
        ok: false,
        code: 'PROVENANCE_MISSING',
        message: `${input.backend} returned no backend provenance`,
      };
    }
    const immutableRef = digestPinnedRef(input.artifact);
    if (immutableRef === null) {
      return {
        ok: false,
        code: 'PROVENANCE_INVALID',
        message: `${input.backend} returned no immutable reference for ${input.artifact.digest}`,
      };
    }

    const directory = await mkdtemp(join(tmpdir(), 'spindrift-provenance-'));
    const provenancePath = join(directory, 'provenance.json');
    try {
      await writeFile(
        provenancePath,
        JSON.stringify(input.provenance.statement),
        { mode: 0o600 },
      );
      const command = [
        this.executable,
        'verify-image',
        immutableRef,
        '--provenance-path',
        provenancePath,
        '--source-uri',
        sourceUriOf(input.source),
        '--print-provenance',
        '--builder-id',
        input.expectedBuilderId,
      ];
      const result = await this.processes.run(command);
      if (result.exitCode !== 0) {
        return {
          ok: false,
          code: 'PROVENANCE_INVALID',
          message: verifierFailure(input.backend, result),
        };
      }

      const envelope = verifiedEnvelope(result.stdout);
      if (envelope === null) {
        return {
          ok: false,
          code: 'PROVENANCE_INVALID',
          message: `${input.backend} verifier returned no readable provenance`,
        };
      }
      const bundleDigest = bundleDigestOf(envelope);
      if (bundleDigest !== input.source.bundleDigest) {
        return {
          ok: false,
          code: 'PROVENANCE_INVALID',
          message:
            bundleDigest === null
              ? `${input.backend} verified provenance does not bind the source bundle digest`
              : `${input.backend} verified provenance names bundle ${bundleDigest}, not ${input.source.bundleDigest}`,
        };
      }

      return {
        ok: true,
        assessment: {
          artifactDigest: input.artifact.digest,
          bundleDigest,
          backend: input.backend,
          builderId: builderIdOf(envelope) ?? input.expectedBuilderId,
          slsaVersion: slsaVersionOf(envelope),
          achievedLevel: lowerLevel(
            input.provenance.claimedLevel,
            input.maximumLevel,
          ),
          verifiedAt: this.now().toISOString(),
          envelope,
        },
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function verifiedEnvelope(stdout: string): unknown | null {
  const output = stdout.trim();
  if (output === '') return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function lowerLevel(left: BuildLevel, right: BuildLevel): BuildLevel {
  return Math.min(left, right) as BuildLevel;
}

function sourceUriOf(source: BuildSource): string {
  if (source.origin.type === 'archive') return source.origin.location;
  return source.origin.repository
    .replace(/^git\+/, '')
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '');
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function builderIdOf(statement: unknown): string | null {
  const root = record(statement);
  const predicate = record(root?.predicate);
  const runDetails = record(predicate?.runDetails);
  const builder = record(runDetails?.builder);
  const id = builder?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function bundleDigestOf(statement: unknown): string | null {
  const root = record(statement);
  const predicate = record(root?.predicate);
  const buildDefinition = record(predicate?.buildDefinition);
  const externalParameters = record(buildDefinition?.externalParameters);
  const digest = externalParameters?.bundleDigest;
  return typeof digest === 'string' && digest !== '' ? digest : null;
}

function slsaVersionOf(statement: unknown): string {
  const predicateType = record(statement)?.predicateType;
  if (typeof predicateType !== 'string') return 'unknown';
  const match = /slsa[^/]*\/v(\d+(?:\.\d+)?)/i.exec(predicateType);
  return match?.[1] ?? 'unknown';
}

function verifierFailure(backend: string, result: ProcessResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return `${backend} provenance did not verify${detail === '' ? '' : `: ${detail}`}`;
}
