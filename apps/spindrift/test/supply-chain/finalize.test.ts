import { describe, expect, test } from 'bun:test';
import type { BuildProvenance } from '../../src/adapters/build/contract.ts';
import type { Artifact } from '../../src/domain/desired-state.ts';
import {
  type ArtifactSigner,
  type CoreSignature,
  CoreSupplyChain,
  CosignSigner,
} from '../../src/supply-chain/sign.ts';
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

    const result = await new CoreSupplyChain(verifier, signer).finalize(
      input(),
    );

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

    const result = await new CoreSupplyChain(verifier, signer).finalize(
      input(),
    );

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

    const result = await new CoreSupplyChain(verifier, signer).finalize(
      input(3),
    );

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

    const result = await new CoreSupplyChain(verifier, signer).finalize(
      input(),
    );

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
