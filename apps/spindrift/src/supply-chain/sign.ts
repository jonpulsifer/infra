/**
 * Core's artifact signature. {@link CoreSupplyChain} calls the signer only
 * after provenance verifies and meets the Target's minimum level.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BuildLevel,
  BuildProvenance,
  BuildSource,
} from '../adapters/build/contract.ts';
import type { Artifact } from '../domain/desired-state.ts';
import {
  type BackendProvenanceAssessment,
  bunProcessExecutor,
  digestPinnedRef,
  type ProcessExecutor,
  type ProvenanceVerifier,
} from './verify.ts';

export interface CoreSignature {
  readonly artifactDigest: string;
  readonly signer: string;
  readonly format: 'cosign';
  readonly bundle: unknown;
  readonly signedAt: string;
}

export interface ArtifactSigner {
  sign(artifact: Artifact): Promise<CoreSignature>;
}

export interface FinalizeArtifactInput {
  readonly artifact: Artifact;
  readonly provenance: BuildProvenance;
  readonly backend: string;
  readonly expectedBuilderId: string;
  readonly maximumLevel: BuildLevel;
  readonly minimumLevel: BuildLevel;
  readonly source: BuildSource;
}

export type FinalizationFailureCode =
  | 'PROVENANCE_MISSING'
  | 'PROVENANCE_INVALID'
  | 'BUILD_LEVEL_BELOW_POLICY'
  | 'SIGNING_FAILED';

export type ArtifactFinalization =
  | {
      readonly ok: true;
      readonly assessment: BackendProvenanceAssessment;
      readonly signature: CoreSignature;
    }
  | {
      readonly ok: false;
      readonly code: FinalizationFailureCode;
      readonly message: string;
    };

/** `ok: false` refuses the deploy, and `reason` is what the operator reads. */
export interface SignatureVerification {
  readonly ok: boolean;
  readonly reason: string | null;
}

export interface VerifySignatureInput {
  readonly artifactDigest: string;
  readonly signature: CoreSignature;
}

export interface SignatureVerifier {
  verify(input: VerifySignatureInput): Promise<SignatureVerification>;
}

export interface SupplyChain {
  finalize(input: FinalizeArtifactInput): Promise<ArtifactFinalization>;
  /**
   * Re-checked at image deploy admission before any row is written, so a
   * finalized Build can still be refused here.
   */
  verifySignature(input: VerifySignatureInput): Promise<SignatureVerification>;
}

export class CoreSupplyChain implements SupplyChain {
  constructor(
    private readonly verifier: ProvenanceVerifier,
    private readonly signer: ArtifactSigner,
    private readonly signatureVerifier: SignatureVerifier,
  ) {}

  async finalize(input: FinalizeArtifactInput): Promise<ArtifactFinalization> {
    const verified = await this.verifier.verify(input);
    if (!verified.ok) return verified;

    if (verified.assessment.achievedLevel < input.minimumLevel) {
      return {
        ok: false,
        code: 'BUILD_LEVEL_BELOW_POLICY',
        message: `${input.backend} produced verified Build Level ${verified.assessment.achievedLevel}, but this Target requires L${input.minimumLevel}`,
      };
    }

    try {
      return {
        ok: true,
        assessment: verified.assessment,
        signature: await this.signer.sign(input.artifact),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: 'SIGNING_FAILED',
        message: `core could not sign the admitted artifact: ${detail}`,
      };
    }
  }

  async verifySignature(
    input: VerifySignatureInput,
  ): Promise<SignatureVerification> {
    if (input.signature.artifactDigest !== input.artifactDigest) {
      return {
        ok: false,
        reason: `recorded signature covers ${input.signature.artifactDigest}, not the admitted artifact ${input.artifactDigest}`,
      };
    }
    return this.signatureVerifier.verify(input);
  }
}

export interface CosignSignerOptions {
  readonly key: string;
  readonly executable?: string;
  readonly processes?: ProcessExecutor;
  readonly now?: () => Date;
}

export class CosignSigner implements ArtifactSigner {
  private readonly executable: string;
  private readonly processes: ProcessExecutor;
  private readonly now: () => Date;

  constructor(private readonly options: CosignSignerOptions) {
    this.executable = options.executable ?? 'spindrift-verifier';
    this.processes = options.processes ?? bunProcessExecutor;
    this.now = options.now ?? (() => new Date());
  }

  async sign(artifact: Artifact): Promise<CoreSignature> {
    const directory = await mkdtemp(join(tmpdir(), 'spindrift-signature-'));
    const bundlePath = join(directory, 'bundle.json');
    try {
      const command = this.signCommand(artifact, bundlePath);
      const result = await this.processes.run(command);
      if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(
          `cosign exited ${result.exitCode}${detail === '' ? '' : `: ${detail}`}`,
        );
      }

      return {
        artifactDigest: artifact.digest,
        signer: this.options.key,
        format: 'cosign',
        bundle: await readBundle(bundlePath, result.stdout),
        signedAt: this.now().toISOString(),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private signCommand(
    artifact: Artifact,
    bundlePath: string,
  ): readonly string[] {
    // Any artifact type: the signature covers the digest, and `files` has one.
    const immutableRef = digestPinnedRef(artifact);
    if (immutableRef === null) {
      throw new Error(`artifact ${artifact.digest} has no immutable reference`);
    }
    return [
      this.executable,
      'sign',
      '--yes',
      '--key',
      this.options.key,
      '--tlog-upload=false',
      '--bundle',
      bundlePath,
      immutableRef,
    ];
  }
}

async function readBundle(path: string, stdout: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    const trimmed = stdout.trim();
    if (trimmed === '') return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return { output: trimmed };
    }
  }
}
