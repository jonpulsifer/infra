import { describe, expect, test } from 'bun:test';
import type { BuildProvenance } from '../../src/adapters/build/contract.ts';
import type { Artifact } from '../../src/domain/desired-state.ts';
import {
  type ArtifactSigner,
  type CoreSignature,
  CoreSupplyChain,
  CosignSigner,
  type SignatureVerifier,
} from '../../src/supply-chain/sign.ts';
import { SpindriftSignatureVerifier } from '../../src/supply-chain/signature.ts';
import type {
  BackendProvenanceAssessment,
  ProcessExecutor,
  ProvenanceVerifier,
} from '../../src/supply-chain/verify.ts';
import { SlsaVerifier } from '../../src/supply-chain/verify.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const BUNDLE = `sha256:${'b'.repeat(64)}`;
const ARTIFACT: Artifact = {
  type: 'image',
  digest: DIGEST,
  refs: [`registry.example.test/apps/shop@${DIGEST}`],
};
const PROVENANCE: BuildProvenance = {
  bundleDigest: BUNDLE,
  claimedLevel: 2,
  statement: {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: { externalParameters: { bundleDigest: BUNDLE } },
      runDetails: {
        builder: { id: 'https://github.com/untrusted/workflows/build.yml' },
      },
    },
  },
};
const VERIFIED: BackendProvenanceAssessment = {
  artifactDigest: DIGEST,
  bundleDigest: BUNDLE,
  backend: 'hosted',
  builderId: 'https://github.com/example/build.yml',
  slsaVersion: '1.2',
  achievedLevel: 2,
  verifiedAt: '2024-06-01T00:00:00.000Z',
  envelope: PROVENANCE.statement,
};
const SIGNATURE: CoreSignature = {
  artifactDigest: DIGEST,
  signer:
    'gcpkms://projects/example/locations/global/keyRings/keys/cryptoKeys/signer',
  format: 'cosign',
  bundle: { mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' },
  signedAt: '2024-06-01T00:00:01.000Z',
};

function input(minimumLevel: 1 | 2 | 3 = 2) {
  return {
    artifact: ARTIFACT,
    provenance: PROVENANCE,
    backend: 'hosted',
    expectedBuilderId: 'https://github.com/actions/runner/github-hosted',
    maximumLevel: 2 as const,
    minimumLevel,
    source: {
      bundleDigest: BUNDLE,
      origin: {
        type: 'repo' as const,
        repository: 'https://github.com/example/shop',
        commit: 'abc123',
        subpath: '.',
        location: 'https://bundles.example.test/source.tgz',
      },
    },
  };
}

/** A signature verifier that accepts every recorded signature. */
const acceptingVerifier: SignatureVerifier = {
  async verify() {
    return { ok: true, reason: null };
  },
};

describe('core admission is verify → sign', () => {
  test('signs only after provenance verifies at the required level', async () => {
    const order: string[] = [];
    const verifier: ProvenanceVerifier = {
      async verify() {
        order.push('verify');
        return { ok: true, assessment: VERIFIED };
      },
    };
    const signer: ArtifactSigner = {
      async sign() {
        order.push('sign');
        return SIGNATURE;
      },
    };

    const result = await new CoreSupplyChain(
      verifier,
      signer,
      acceptingVerifier,
    ).finalize(input());

    expect(result).toEqual({
      ok: true,
      assessment: VERIFIED,
      signature: SIGNATURE,
    });
    expect(order).toEqual(['verify', 'sign']);
  });

  test('invalid provenance never reaches the signer', async () => {
    let signed = false;
    const verifier: ProvenanceVerifier = {
      async verify() {
        return {
          ok: false,
          code: 'PROVENANCE_INVALID',
          message: 'the backend signature is invalid',
        };
      },
    };
    const signer: ArtifactSigner = {
      async sign() {
        signed = true;
        return SIGNATURE;
      },
    };

    const result = await new CoreSupplyChain(
      verifier,
      signer,
      acceptingVerifier,
    ).finalize(input());

    expect(result).toEqual({
      ok: false,
      code: 'PROVENANCE_INVALID',
      message: 'the backend signature is invalid',
    });
    expect(signed).toBe(false);
  });

  test('evidence below current Target policy never reaches the signer', async () => {
    let signed = false;
    const verifier: ProvenanceVerifier = {
      async verify() {
        return { ok: true, assessment: VERIFIED };
      },
    };
    const signer: ArtifactSigner = {
      async sign() {
        signed = true;
        return SIGNATURE;
      },
    };

    const result = await new CoreSupplyChain(
      verifier,
      signer,
      acceptingVerifier,
    ).finalize(input(3));

    expect(result).toEqual({
      ok: false,
      code: 'BUILD_LEVEL_BELOW_POLICY',
      message:
        'hosted produced verified Build Level 2, but this Target requires L3',
    });
    expect(signed).toBe(false);
  });

  test('a signer failure is a red result rather than unrecorded success', async () => {
    const verifier: ProvenanceVerifier = {
      async verify() {
        return { ok: true, assessment: VERIFIED };
      },
    };
    const signer: ArtifactSigner = {
      async sign() {
        throw new Error('KMS denied the signature');
      },
    };

    const result = await new CoreSupplyChain(
      verifier,
      signer,
      acceptingVerifier,
    ).finalize(input());

    expect(result).toEqual({
      ok: false,
      code: 'SIGNING_FAILED',
      message:
        'core could not sign the admitted artifact: KMS denied the signature',
    });
  });
});

describe('the pinned process boundaries', () => {
  test('verifies the copied envelope against an immutable image ref', async () => {
    const commands: string[][] = [];
    const processes: ProcessExecutor = {
      async run(command) {
        commands.push([...command]);
        return {
          exitCode: 0,
          stdout: JSON.stringify(PROVENANCE.statement),
          stderr: '',
        };
      },
    };

    const result = await new SlsaVerifier({
      executable: '/usr/local/bin/slsa-verifier',
      processes,
      now: () => new Date('2024-06-01T00:00:00.000Z'),
    }).verify(input());

    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 3)).toEqual([
      '/usr/local/bin/slsa-verifier',
      'verify-image',
      ARTIFACT.refs[0]!,
    ]);
    expect(commands[0]).toContain('--provenance-path');
    expect(commands[0]).toContain('--source-uri');
    expect(commands[0]).toContain('--builder-id');
    expect(
      commands[0]?.at((commands[0]?.indexOf('--builder-id') ?? -1) + 1),
    ).toBe('https://github.com/actions/runner/github-hosted');
    expect(commands[0]).not.toContain(
      'https://github.com/untrusted/workflows/build.yml',
    );
    expect(commands[0]).not.toContain('registry.example.test/apps/shop:latest');
  });

  test('signs the immutable ref without a transparency-log upload', async () => {
    const commands: string[][] = [];
    const processes: ProcessExecutor = {
      async run(command) {
        commands.push([...command]);
        return {
          exitCode: 0,
          stdout:
            '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}',
          stderr: '',
        };
      },
    };

    const result = await new CosignSigner({
      key: SIGNATURE.signer,
      executable: '/usr/local/bin/cosign',
      processes,
      now: () => new Date(SIGNATURE.signedAt),
    }).sign(ARTIFACT);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 2)).toEqual(['/usr/local/bin/cosign', 'sign']);
    expect(commands[0]).toContain('--tlog-upload=false');
    expect(commands[0]?.at(-1)).toBe(ARTIFACT.refs[0]);
    expect(result).toEqual(SIGNATURE);
  });
});

describe('admission re-verifies the recorded signature', () => {
  const okVerifier: ProvenanceVerifier = {
    async verify() {
      return { ok: true, assessment: VERIFIED };
    },
  };
  const okSigner: ArtifactSigner = {
    async sign() {
      return SIGNATURE;
    },
  };

  test('an admitting verifier proceeds', async () => {
    const checked = await new CoreSupplyChain(
      okVerifier,
      okSigner,
      acceptingVerifier,
    ).verifySignature({ artifactDigest: DIGEST, signature: SIGNATURE });

    expect(checked).toEqual({ ok: true, reason: null });
  });

  test('a recorded signature covering a different digest refuses', async () => {
    const checked = await new CoreSupplyChain(
      okVerifier,
      okSigner,
      acceptingVerifier,
    ).verifySignature({
      artifactDigest: `sha256:${'c'.repeat(64)}`,
      signature: SIGNATURE,
    });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toContain('not the admitted artifact');
  });

  test('a verifier that refuses blocks admission fail-closed', async () => {
    const refusing: SignatureVerifier = {
      async verify() {
        return {
          ok: false,
          reason: 'signature does not verify against the recorded digest',
        };
      },
    };
    const checked = await new CoreSupplyChain(
      okVerifier,
      okSigner,
      refusing,
    ).verifySignature({ artifactDigest: DIGEST, signature: SIGNATURE });

    expect(checked).toEqual({
      ok: false,
      reason: 'signature does not verify against the recorded digest',
    });
  });
});

describe('the pinned verify-signature process boundary', () => {
  const SIGNED_BUNDLE = {
    mediaType: 'application/vnd.spindrift.signature.v1+json',
    algorithm: 'ed25519',
    publicKey: 'MCowBQYDK2VwAyEAfIbVW0Es9rCDaS7ZNZnYDvwEkxknflmNjZ2kfYdBhx8=',
    artifactDigest: DIGEST,
    signature:
      'X0brov0uDq2EXscKpR12YKVVNPmuwEindNqE0blDITLQbGgcQbkBrEOR45qbTK4lZqdS1iZqfMZtZ8/zyKE8DA==',
  };
  const signed: CoreSignature = {
    artifactDigest: DIGEST,
    signer: 'fake://core',
    format: 'cosign',
    bundle: SIGNED_BUNDLE,
    signedAt: '2024-06-01T00:00:01.000Z',
  };

  test('exit 0 admits; the binary is invoked with verify-signature', async () => {
    const recorded: string[][] = [];
    const processes: ProcessExecutor = {
      async run(command) {
        recorded.push([...command]);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const checked = await new SpindriftSignatureVerifier({
      executable: '/usr/local/bin/spindrift-verifier',
      processes,
      signerKey: '/etc/spindrift/signer.pem',
    }).verify({
      artifactDigest: DIGEST,
      signature: signed,
    });

    expect(checked).toEqual({ ok: true, reason: null });
    expect(recorded[0]?.slice(0, 2)).toEqual([
      '/usr/local/bin/spindrift-verifier',
      'verify-signature',
    ]);
    expect(recorded[0]).toContain('--artifact-digest');
    expect(recorded[0]?.at(recorded[0].indexOf('--artifact-digest') + 1)).toBe(
      DIGEST,
    );
    expect(recorded[0]).toContain('--bundle-path');
    // The signer key pins admission — verify-signature refuses any bundle
    // whose embedded public key does not match the one derived from this.
    expect(recorded[0]).toContain('--signer-key');
    expect(recorded[0]?.at(recorded[0].indexOf('--signer-key') + 1)).toBe(
      '/etc/spindrift/signer.pem',
    );
  });

  test('non-zero exit refuses with stderr, never a silent admit', async () => {
    const processes: ProcessExecutor = {
      async run() {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'signature does not verify against the artifact digest',
        };
      },
    };

    const checked = await new SpindriftSignatureVerifier({
      processes,
      signerKey: '/etc/spindrift/signer.pem',
    }).verify({
      artifactDigest: DIGEST,
      signature: signed,
    });

    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toBe(
      'signature does not verify against the artifact digest',
    );
  });
});
