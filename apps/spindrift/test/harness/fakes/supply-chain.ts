/**
 * A fake `spindrift-verifier` process under the real {@link SlsaVerifier},
 * {@link CosignSigner} and {@link SpindriftSignatureVerifier}. It signs with
 * real Ed25519 keys derived from the signer reference.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signWith,
  verify as verifyWith,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Artifact } from '../../../src/domain/desired-state.ts';
import {
  type ArtifactSigner,
  type CoreSignature,
  CoreSupplyChain,
  CosignSigner,
  type FinalizeArtifactInput,
  type SignatureVerification,
  type SignatureVerifier,
  type VerifySignatureInput,
} from '../../../src/supply-chain/sign.ts';
import { SpindriftSignatureVerifier } from '../../../src/supply-chain/signature.ts';
import {
  type ProcessExecutor,
  type ProcessResult,
  type ProvenanceVerification,
  type ProvenanceVerifier,
  SlsaVerifier,
  type VerifyProvenanceInput,
} from '../../../src/supply-chain/verify.ts';

export const TEST_SIGNER_KEY = '/spindrift/test-signer.key';

/** Must match `SignatureMediaType` in `pkg/verifier/sign.go`. */
const SIGNATURE_MEDIA_TYPE = 'application/vnd.spindrift.signature.v1+json';

/** PKCS#8 header for a raw 32-byte Ed25519 seed. */
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

function derFor(reference: string): Buffer {
  const seed = createHash('sha256').update(reference).digest();
  return Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
}

/**
 * The real signer reads a key file at the reference; this derives the key from
 * the reference instead, so a different reference is a different key.
 */
function keyFor(reference: string) {
  return createPrivateKey({
    key: derFor(reference),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyObjectOf(reference: string) {
  return createPublicKey(
    keyFor(reference).export({ format: 'pem', type: 'pkcs8' }).toString(),
  );
}

function publicKeyOf(reference: string): string {
  return publicKeyObjectOf(reference)
    .export({ format: 'der', type: 'spki' })
    .toString('base64');
}

/**
 * A signature the verifier admits, for a fixture that inserts a SUCCEEDED
 * Build directly. The verifier rejects a bundle with only a `mediaType`.
 */
export function testSignature(
  artifactDigest: string,
  signedAt = '2024-06-01T00:00:01.000Z',
): CoreSignature {
  return {
    artifactDigest,
    signer: TEST_SIGNER_KEY,
    format: 'cosign',
    bundle: {
      mediaType: SIGNATURE_MEDIA_TYPE,
      algorithm: 'ed25519',
      publicKey: publicKeyOf(TEST_SIGNER_KEY),
      artifactDigest,
      signature: signWith(
        null,
        Buffer.from(artifactDigest),
        keyFor(TEST_SIGNER_KEY),
      ).toString('base64'),
    },
    signedAt,
  };
}

export interface RecordedProcess {
  readonly command: readonly string[];
  readonly result: ProcessResult;
}

export interface FakeVerifierProcessOptions {
  /** Not read: each subcommand takes its key reference from argv. */
  readonly signerKey?: string;
  /** Stderr for a refused `verify-image`, as the binary prints it. */
  readonly refuseVerify?: string;
  /** Stderr for a refused `sign`. */
  readonly refuseSign?: string;
}

/** The verifier binary's argv, refusal messages and output. */
export class FakeVerifierProcess implements ProcessExecutor {
  readonly runs: RecordedProcess[] = [];

  constructor(private readonly options: FakeVerifierProcessOptions = {}) {}

  async run(command: readonly string[]): Promise<ProcessResult> {
    const result = await this.dispatch(command);
    this.runs.push({ command: [...command], result });
    return result;
  }

  callsTo(subcommand: string): readonly RecordedProcess[] {
    return this.runs.filter((run) => run.command[1] === subcommand);
  }

  private dispatch(command: readonly string[]): Promise<ProcessResult> {
    switch (command[1]) {
      case 'verify-image':
        return this.verifyImage(command.slice(2));
      case 'sign':
        return this.sign(command.slice(2));
      case 'verify-signature':
        return this.verifySignature(command.slice(2));
      default:
        return Promise.resolve(
          failed(`unknown command: ${command[1] ?? ''}\n`),
        );
    }
  }

  /** Legacy `verify-image`, with the refusal messages of `verify.go`. */
  private async verifyImage(args: readonly string[]): Promise<ProcessResult> {
    const flags = legacyFlags(args, [
      'provenance-path',
      'source-uri',
      'builder-id',
    ]);
    if (flags.values['provenance-path'] === undefined) {
      return failed('error: --provenance-path is required\n');
    }

    let raw: string;
    try {
      raw = await readFile(flags.values['provenance-path'], 'utf8');
    } catch (error) {
      return failed(`error reading provenance path: ${String(error)}\n`);
    }

    if (this.options.refuseVerify !== undefined) {
      return failed(`${this.options.refuseVerify}\n`);
    }

    const ref = flags.positional[0] ?? '';
    const digest = ref.includes('@')
      ? ref.slice(ref.lastIndexOf('@') + 1)
      : ref;
    if (digest === '') {
      return failed(
        'hosted returned no immutable image reference for digest\n',
      );
    }

    if (raw.trim() === '' || raw.trim() === 'null') {
      return failed('hosted returned no backend provenance\n');
    }
    let statement: Record<string, unknown>;
    try {
      statement = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return failed(
        'hosted provenance did not verify: invalid JSON statement\n',
      );
    }

    const builderId = builderIdOf(statement);
    const expected = flags.values['builder-id'];
    if (
      builderId !== null &&
      expected !== undefined &&
      builderId !== expected
    ) {
      return failed(
        `hosted provenance builder mismatch: expected ${expected}, got ${builderId}\n`,
      );
    }

    const subject = subjectDigestOf(statement);
    if (subject !== null && subject !== digest) {
      return failed(
        `hosted provenance subject names "${subject}", not the admitted artifact ${digest}\n`,
      );
    }

    // The binary prints the envelope, which is the provenance file verbatim,
    // and core binds the bundle digest against it.
    return { exitCode: 0, stdout: `${raw}\n`, stderr: '' };
  }

  /** `sign` in the cosign flag shape {@link CosignSigner} builds. */
  private async sign(args: readonly string[]): Promise<ProcessResult> {
    const flags = legacyFlags(args, ['key', 'bundle']);
    if (this.options.refuseSign !== undefined) {
      return failed(`${this.options.refuseSign}\n`);
    }

    const ref = flags.positional[0] ?? '';
    const digest = ref.includes('@')
      ? ref.slice(ref.lastIndexOf('@') + 1)
      : ref;
    if (digest === '') return failed('artifact has no digest\n');
    const key = flags.values.key;
    if (key === undefined || key === '') {
      return failed('key is required for signing\n');
    }

    const bundle = JSON.stringify({
      mediaType: SIGNATURE_MEDIA_TYPE,
      algorithm: 'ed25519',
      publicKey: publicKeyOf(key),
      artifactDigest: digest,
      signature: signWith(null, Buffer.from(digest), keyFor(key)).toString(
        'base64',
      ),
    });
    if (flags.values.bundle !== undefined) {
      await writeFile(flags.values.bundle, bundle, { mode: 0o600 });
    }
    return { exitCode: 0, stdout: `${bundle}\n`, stderr: '' };
  }

  private async verifySignature(
    args: readonly string[],
  ): Promise<ProcessResult> {
    const flags = legacyFlags(args, [
      'artifact-digest',
      'bundle-path',
      'signer-key',
    ]);
    const digest = flags.values['artifact-digest'];
    const path = flags.values['bundle-path'];
    const signerKey = flags.values['signer-key'];
    if (digest === undefined || path === undefined || signerKey === undefined) {
      return failed(
        'error: --artifact-digest, --bundle-path, and --signer-key are required\n',
      );
    }

    let bundle: {
      mediaType?: string;
      algorithm?: string;
      publicKey?: string;
      artifactDigest?: string;
      signature?: string;
    };
    try {
      bundle = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      return failed(`signature did not verify: ${String(error)}\n`);
    }

    if (bundle.mediaType !== SIGNATURE_MEDIA_TYPE) {
      return failed(
        `signature did not verify: unsupported signature mediaType "${bundle.mediaType ?? ''}"\n`,
      );
    }
    if (bundle.algorithm !== 'ed25519') {
      return failed(
        `signature did not verify: unsupported signature algorithm "${bundle.algorithm ?? ''}"\n`,
      );
    }
    if (bundle.artifactDigest !== digest) {
      return failed(
        `signature did not verify: bundle covers digest "${bundle.artifactDigest ?? ''}", not "${digest}"\n`,
      );
    }
    // Only the configured signer's key is trusted, never the bundle's own.
    if (bundle.publicKey !== publicKeyOf(signerKey)) {
      return failed(
        'signature did not verify: bundle public key is not the trusted Spindrift signer\n',
      );
    }
    const ok =
      bundle.signature !== undefined &&
      verifyWith(
        null,
        Buffer.from(digest),
        publicKeyObjectOf(signerKey),
        Buffer.from(bundle.signature, 'base64'),
      );
    if (!ok) {
      return failed(
        'signature did not verify: signature does not verify against the digest\n',
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  }
}

/** `answer` replaces the real verifier, for tests of a backend refusal. */
class RecordingVerifier implements ProvenanceVerifier {
  readonly verified: VerifyProvenanceInput[] = [];

  constructor(
    private readonly inner: ProvenanceVerifier,
    private readonly answer?: (
      input: VerifyProvenanceInput,
    ) => ProvenanceVerification | Promise<ProvenanceVerification>,
  ) {}

  async verify(input: VerifyProvenanceInput): Promise<ProvenanceVerification> {
    this.verified.push(input);
    if (this.answer) return this.answer(input);
    return this.inner.verify(input);
  }
}

class RecordingSigner implements ArtifactSigner {
  readonly signed: Artifact[] = [];
  /** A scripted KMS refusal. */
  failure: Error | null = null;

  constructor(private readonly inner: ArtifactSigner) {}

  async sign(artifact: Artifact): Promise<CoreSignature> {
    if (this.failure !== null) throw this.failure;
    const signature = await this.inner.sign(artifact);
    this.signed.push(artifact);
    return signature;
  }
}

/**
 * Answers with the real verifier over the bundle the signer wrote, unless
 * `answer` is given, so no deploy test passes the signature gate for free.
 */
export class RecordingSignatureVerifier implements SignatureVerifier {
  readonly admissions: VerifySignatureInput[] = [];

  constructor(
    private readonly inner: SignatureVerifier,
    private readonly answer?: (
      input: VerifySignatureInput,
    ) => SignatureVerification | Promise<SignatureVerification>,
  ) {}

  async verify(input: VerifySignatureInput): Promise<SignatureVerification> {
    this.admissions.push(input);
    if (this.answer) return this.answer(input);
    return this.inner.verify(input);
  }
}

export class SupplyChainHarness extends CoreSupplyChain {
  readonly finalized: FinalizeArtifactInput[] = [];
  readonly signed: Artifact[];
  readonly signatureChecks: RecordingSignatureVerifier;
  readonly signing: RecordingSigner;
  /** The process all three real classes run against. */
  readonly processes: FakeVerifierProcess;

  constructor(
    answer?: (
      input: VerifyProvenanceInput,
    ) => ProvenanceVerification | Promise<ProvenanceVerification>,
    signatureAnswer?: (
      input: VerifySignatureInput,
    ) => SignatureVerification | Promise<SignatureVerification>,
    options: FakeVerifierProcessOptions = {},
  ) {
    const processes = new FakeVerifierProcess(options);
    const now = () => new Date('2024-06-01T00:00:01.000Z');
    const verifier = new RecordingVerifier(
      new SlsaVerifier({ processes, now }),
      answer,
    );
    const signer = new RecordingSigner(
      new CosignSigner({ key: TEST_SIGNER_KEY, processes, now }),
    );
    const signatureVerifier = new RecordingSignatureVerifier(
      new SpindriftSignatureVerifier({ processes, signerKey: TEST_SIGNER_KEY }),
      signatureAnswer,
    );
    super(verifier, signer, signatureVerifier);
    this.processes = processes;
    this.signed = signer.signed;
    this.signing = signer;
    this.signatureChecks = signatureVerifier;
  }

  override async finalize(input: FinalizeArtifactInput) {
    this.finalized.push(input);
    return super.finalize(input);
  }
}

function failed(stderr: string): ProcessResult {
  return { exitCode: 1, stdout: '', stderr };
}

/**
 * The manual argv walk `main.go` does for `verify-image` and legacy `sign`:
 * named flags take the next argument, and any other flag is skipped.
 */
function legacyFlags(
  args: readonly string[],
  named: readonly string[],
): { values: Record<string, string>; positional: string[] } {
  const values: Record<string, string> = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const name = arg.replace(/^--?/, '');
    if (arg.startsWith('-') && named.includes(name)) {
      const value = args[index + 1];
      if (value !== undefined) {
        values[name] = value;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  return { values, positional };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function builderIdOf(statement: Record<string, unknown>): string | null {
  const builder = record(
    record(record(statement.predicate)?.runDetails)?.builder,
  );
  const id = builder?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

function subjectDigestOf(statement: Record<string, unknown>): string | null {
  const subjects = statement.subject;
  if (!Array.isArray(subjects) || subjects.length === 0) return null;
  const digest = record(record(subjects[0])?.digest)?.sha256;
  if (typeof digest !== 'string' || digest === '') return null;
  return digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
}
