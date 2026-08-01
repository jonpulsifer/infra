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
import {
  FakeVerifierProcess,
  TEST_SIGNER_KEY,
} from '../harness/fakes/supply-chain.ts';

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

/**
 * The real classes over the pinned binary's process seam (Task 17).
 *
 * Everything above this point either drives `CoreSupplyChain` over hand-written
 * doubles or drives one real class over a process that always says yes. What is
 * here is the part that used to be unreachable: the verifier's own refusals,
 * its `min()`, its four-deep read of the envelope, and a signature that is
 * signed and re-verified rather than asserted.
 */
describe('the real verifier over the pinned process', () => {
  function statement(overrides: {
    bundleDigest?: string | null;
    builderId?: string;
    subject?: string;
  }): unknown {
    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'registry.example.test/apps/shop',
          digest: {
            sha256: (overrides.subject ?? DIGEST).replace(/^sha256:/, ''),
          },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          externalParameters:
            overrides.bundleDigest === null
              ? {}
              : { bundleDigest: overrides.bundleDigest ?? BUNDLE },
        },
        runDetails: {
          builder: {
            id:
              overrides.builderId ??
              'https://github.com/actions/runner/github-hosted',
          },
        },
      },
    };
  }

  function verifying(processes: FakeVerifierProcess) {
    return new SlsaVerifier({
      processes,
      now: () => new Date('2024-06-01T00:00:00.000Z'),
    });
  }

  test('the achieved level is the lower of the claim and the profile ceiling', async () => {
    // `min(claimedLevel, maximumLevel)` had no coverage while the fake answered
    // `achievedLevel: input.maximumLevel`, so a route claiming less than its
    // profile permits was recorded at its ceiling.
    const processes = new FakeVerifierProcess();
    const claimingLess = await verifying(processes).verify({
      ...input(),
      provenance: {
        bundleDigest: BUNDLE,
        claimedLevel: 1,
        statement: statement({}),
      },
      maximumLevel: 3,
    });

    expect(claimingLess.ok).toBe(true);
    if (!claimingLess.ok) return;
    expect(claimingLess.assessment.achievedLevel).toBe(1);
  });

  test('a claim above the profile ceiling is capped, not honoured', async () => {
    const processes = new FakeVerifierProcess();
    const claimingMore = await verifying(processes).verify({
      ...input(),
      provenance: {
        bundleDigest: BUNDLE,
        claimedLevel: 3,
        statement: statement({}),
      },
      maximumLevel: 2,
    });

    expect(claimingMore.ok).toBe(true);
    if (!claimingMore.ok) return;
    expect(claimingMore.assessment.achievedLevel).toBe(2);
  });

  test('a verified envelope naming another bundle refuses', async () => {
    // §16's join, checked rather than copied: the *verified* document has to
    // name the bundle core staged, or the provenance describes another build.
    const other = `sha256:${'d'.repeat(64)}`;
    const result = await verifying(new FakeVerifierProcess()).verify({
      ...input(),
      provenance: {
        bundleDigest: BUNDLE,
        claimedLevel: 2,
        statement: statement({ bundleDigest: other }),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVENANCE_INVALID');
    expect(result.message).toContain(`names bundle ${other}`);
  });

  test('a verified envelope that binds no bundle at all refuses', async () => {
    const result = await verifying(new FakeVerifierProcess()).verify({
      ...input(),
      provenance: {
        bundleDigest: BUNDLE,
        claimedLevel: 2,
        statement: statement({ bundleDigest: null }),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVENANCE_INVALID');
    expect(result.message).toContain('does not bind the source bundle digest');
  });

  test('an artifact with no digest-pinned reference never spawns anything', async () => {
    // The check/use race the verifier's contract warns about: a tag can move
    // between the check and the pull, so a tag never reaches the tool.
    const processes = new FakeVerifierProcess();
    const result = await verifying(processes).verify({
      ...input(),
      artifact: {
        type: 'image',
        digest: DIGEST,
        refs: ['registry.example.test/apps/shop:latest'],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVENANCE_INVALID');
    expect(result.message).toContain('no immutable reference');
    expect(processes.runs).toHaveLength(0);
  });

  test('a builder the route did not expect refuses at the binary', async () => {
    const result = await verifying(new FakeVerifierProcess()).verify({
      ...input(),
      provenance: {
        bundleDigest: BUNDLE,
        claimedLevel: 2,
        statement: statement({
          builderId: 'https://github.com/untrusted/workflows/build.yml',
        }),
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVENANCE_INVALID');
    expect(result.message).toContain('builder mismatch');
  });

  test('a files artifact is verified and signed like any other digest', async () => {
    // §16 says core "signs that digest", and a static site has one. Gating the
    // supply chain on `type === 'image'` refused every files build before the
    // verifier was even spawned.
    const processes = new FakeVerifierProcess();
    const artifact: Artifact = {
      type: 'files',
      digest: DIGEST,
      refs: [`registry.example.test/artifacts@${DIGEST}`],
    };
    const verified = await verifying(processes).verify({
      ...input(),
      artifact,
      provenance: {
        bundleDigest: BUNDLE,
        claimedLevel: 2,
        statement: statement({}),
      },
    });

    expect(verified.ok).toBe(true);
    const signature = await new CosignSigner({
      key: TEST_SIGNER_KEY,
      processes,
    }).sign(artifact);
    expect(signature.artifactDigest).toBe(DIGEST);
  });
});

describe('a signature that is signed and re-verified, not asserted', () => {
  const ARTIFACT_REF = `registry.example.test/apps/shop@${DIGEST}`;

  async function signOnce(processes: FakeVerifierProcess) {
    return new CosignSigner({ key: TEST_SIGNER_KEY, processes }).sign({
      type: 'image',
      digest: DIGEST,
      refs: [ARTIFACT_REF],
    });
  }

  test('what the signer wrote is what admission admits', async () => {
    const processes = new FakeVerifierProcess();
    const signature = await signOnce(processes);

    const admitted = await new SpindriftSignatureVerifier({
      processes,
      signerKey: TEST_SIGNER_KEY,
    }).verify({ artifactDigest: DIGEST, signature });

    expect(admitted).toEqual({ ok: true, reason: null });
    // The bundle came back through the file the signer wrote, not through
    // stdout — which is the path `CosignSigner` prefers and had never been
    // exercised against a process that writes one.
    expect(processes.callsTo('sign')).toHaveLength(1);
  });

  test('a bundle covering another digest is refused at admission', async () => {
    const processes = new FakeVerifierProcess();
    const signature = await signOnce(processes);

    const admitted = await new SpindriftSignatureVerifier({
      processes,
      signerKey: TEST_SIGNER_KEY,
    }).verify({ artifactDigest: `sha256:${'e'.repeat(64)}`, signature });

    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.reason).toContain('bundle covers digest');
  });

  test('a bundle signed by another key is refused even though it is self-consistent', async () => {
    // The pin: admission derives the expected public key from the trusted
    // signer reference, so a bundle whose own key verifies its own signature
    // still fails.
    const signature = await signOnce(
      new FakeVerifierProcess({ signerKey: '/spindrift/other.key' }),
    );
    const forged = {
      ...signature,
      bundle: {
        ...(signature.bundle as Record<string, unknown>),
        publicKey:
          'MCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
    };

    const admitted = await new SpindriftSignatureVerifier({
      processes: new FakeVerifierProcess(),
      signerKey: TEST_SIGNER_KEY,
    }).verify({ artifactDigest: DIGEST, signature: forged });

    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.reason).toContain('not the trusted Spindrift signer');
  });

  test('a tampered signature is refused', async () => {
    const processes = new FakeVerifierProcess();
    const signature = await signOnce(processes);
    const bundle = signature.bundle as { signature: string };
    const tampered = {
      ...signature,
      bundle: {
        ...bundle,
        signature: Buffer.from(
          Buffer.from(bundle.signature, 'base64').reverse(),
        ).toString('base64'),
      },
    };

    const admitted = await new SpindriftSignatureVerifier({
      processes,
      signerKey: TEST_SIGNER_KEY,
    }).verify({ artifactDigest: DIGEST, signature: tampered });

    expect(admitted.ok).toBe(false);
    if (admitted.ok) return;
    expect(admitted.reason).toContain('does not verify');
  });
});
