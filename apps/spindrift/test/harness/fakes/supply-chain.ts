/**
 * Far-side doubles for core's real supply-chain policy.
 *
 * Tests run {@link CoreSupplyChain}; only the native verifier process and KMS
 * signer behind its contracts are faked. This preserves verify → policy → sign
 * in command tests while still letting them script a backend refusal.
 */
import type { Artifact } from '../../../src/domain/desired-state.ts';
import {
  type ArtifactSigner,
  CoreSupplyChain,
  type FinalizeArtifactInput,
} from '../../../src/supply-chain/sign.ts';
import type {
  ProvenanceVerification,
  ProvenanceVerifier,
  VerifyProvenanceInput,
} from '../../../src/supply-chain/verify.ts';

class RecordingVerifier implements ProvenanceVerifier {
  readonly verified: VerifyProvenanceInput[] = [];

  constructor(
    private readonly answer?: (
      input: VerifyProvenanceInput,
    ) => ProvenanceVerification | Promise<ProvenanceVerification>,
  ) {}

  async verify(input: VerifyProvenanceInput): Promise<ProvenanceVerification> {
    this.verified.push(input);
    if (this.answer) return this.answer(input);
    return {
      ok: true,
      assessment: {
        artifactDigest: input.artifact.digest,
        bundleDigest: input.source.bundleDigest,
        backend: input.backend,
        builderId: `fake://${input.backend}`,
        slsaVersion: '1.2',
        achievedLevel: input.maximumLevel,
        verifiedAt: '2024-06-01T00:00:00.000Z',
        envelope: input.provenance.statement,
      },
    };
  }
}

class RecordingSigner implements ArtifactSigner {
  readonly signed: Artifact[] = [];

  async sign(artifact: Artifact) {
    this.signed.push(artifact);
    return {
      artifactDigest: artifact.digest,
      signer: 'fake://core',
      format: 'cosign' as const,
      bundle: { fake: true },
      signedAt: '2024-06-01T00:00:01.000Z',
    };
  }
}

export class SupplyChainHarness extends CoreSupplyChain {
  readonly finalized: FinalizeArtifactInput[] = [];
  readonly signed: Artifact[];

  constructor(
    answer?: (
      input: VerifyProvenanceInput,
    ) => ProvenanceVerification | Promise<ProvenanceVerification>,
  ) {
    const verifier = new RecordingVerifier(answer);
    const signer = new RecordingSigner();
    super(verifier, signer);
    this.signed = signer.signed;
  }

  override async finalize(input: FinalizeArtifactInput) {
    this.finalized.push(input);
    return super.finalize(input);
  }
}
