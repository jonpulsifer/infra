/**
 * The far side of core's supply chain: the pinned `spindrift-verifier` process.
 *
 * § Testing: **"Fake the far side, not our side."** The far side here is a
 * subprocess, and all three of core's supply-chain classes already expose a
 * {@link ProcessExecutor} seam for it. So {@link SupplyChainHarness} composes
 * the *real* {@link SlsaVerifier}, {@link CosignSigner} and
 * {@link SpindriftSignatureVerifier} over {@link FakeVerifierProcess} — their
 * real argv construction, their real temp-file handling, their real stdout
 * parsing and their real refusal paths all run in every test that touches a
 * build or a deploy.
 *
 * {@link FakeVerifierProcess} answers the argv `apps/spindrift-verifier/main.go`
 * answers, refuses what it refuses, and prints what it prints — including the
 * detail that `verify-image --print-provenance` echoes the *provenance file it
 * was handed* (`verify.go`: `Envelope: req.Provenance.Statement`), which is what
 * makes the TypeScript side's bundle-digest binding a real check.
 *
 * **The signature is genuinely cryptographic.** `sign` mints a real Ed25519
 * keypair derived from the signer reference and signs the digest; the bundle it
 * writes carries the same five fields `pkg/verifier/sign.go` writes;
 * `verify-signature` pins the embedded public key against the trusted signer
 * before checking the signature. A tampered bundle, a bundle covering another
 * digest, or a bundle signed by a different key all fail here exactly as they
 * would in production.
 *
 * Scripted answers survive for the tests that need a backend to refuse — but
 * they are an override on top of the real class, not a replacement for it, so
 * the unscripted path every other test runs is the real one.
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

/** The signer reference the harness signs and admits with. */
export const TEST_SIGNER_KEY = '/spindrift/test-signer.key';

/** What `pkg/verifier/sign.go` writes, field for field. */
const SIGNATURE_MEDIA_TYPE = 'application/vnd.spindrift.signature.v1+json';

/** PKCS#8 header for a raw 32-byte Ed25519 seed. */
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

/** A PKCS#8 Ed25519 key, seeded by the signer reference itself. */
function derFor(reference: string): Buffer {
  const seed = createHash('sha256').update(reference).digest();
  return Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
}

/**
 * A keypair that is the same every time for a given signer reference.
 *
 * The real signer loads an Ed25519 private key from the path it was given, so
 * the fake derives one from that path instead: same reference, same key, and a
 * *different* reference is genuinely a different key — which is what makes the
 * admission pin testable rather than assumed.
 */
function keyFor(reference: string) {
  return createPrivateKey({
    key: derFor(reference),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyObjectOf(reference: string) {
  // Derived from the private key, the way the binary derives the expected
  // public key from the signer reference it was pinned to.
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
 * A signature the pinned verifier will admit, for a fixture that inserts a
 * SUCCEEDED Build directly.
 *
 * A stored `{ mediaType: … }` and nothing else is exactly the placeholder
 * `pkg/verifier/sign.go` documents as rejected, so a fixture carrying one is a
 * fixture whose deploy would be refused in production. This mints what the
 * harness's own signer would have written for that digest.
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

/** One invocation, as the harness recorded it. */
export interface RecordedProcess {
  readonly command: readonly string[];
  readonly result: ProcessResult;
}

export interface FakeVerifierProcessOptions {
  /** The signer reference whose key the process holds. */
  readonly signerKey?: string;
  /**
   * Refuse `verify-image` with this message on stderr, as the binary does when
   * `verifier.Verify` answers `!ok`.
   */
  readonly refuseVerify?: string;
  /** Refuse `sign` with this message on stderr. */
  readonly refuseSign?: string;
}

/**
 * The pinned verifier binary, as a process.
 *
 * Everything it refuses, `main.go` and `pkg/verifier` refuse for the same
 * reason and with the same words. Everything it accepts, they accept.
 */
export class FakeVerifierProcess implements ProcessExecutor {
  /** Every invocation, in order — the assertion surface for argv. */
  readonly runs: RecordedProcess[] = [];

  constructor(private readonly options: FakeVerifierProcessOptions = {}) {}

  async run(command: readonly string[]): Promise<ProcessResult> {
    const result = await this.dispatch(command);
    this.runs.push({ command: [...command], result });
    return result;
  }

  /** Every invocation of one subcommand, for a test that wants only those. */
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

  /**
   * `verify-image`, which is the legacy slsa-verifier-shaped path core calls.
   *
   * The refusals below are `pkg/verifier/verify.go` steps 1-4c in order, and
   * the success case prints `Assessment.Envelope` — the provenance file,
   * verbatim — because that is what the binary prints.
   */
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

    // `--print-provenance` prints the envelope, which is the statement it was
    // handed. Nothing is synthesised here, which is the point: the bundle
    // digest core binds against has to have come out of the document.
    return { exitCode: 0, stdout: `${raw}\n`, stderr: '' };
  }

  /** `sign`, in cosign's flag shape — what {@link CosignSigner} builds. */
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

  /** `verify-signature`, including the signer pin admission depends on. */
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
    // The pin: the bundle's own key is not trusted, the configured one is.
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

/**
 * Records what core asked for, then asks the real verifier.
 *
 * Recording is not faking: the delegate below is the production class. The
 * optional answer is the one escape hatch, for the tests whose subject is "the
 * backend refused" rather than "the verifier ran".
 */
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
  /** A KMS refusing is a far-side event, so a test may script one. */
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
 * Records each admission check, then runs the real one.
 *
 * The default answer is the pinned verifier's, over the bundle the signer
 * actually wrote — a stub `{ ok: true }` would pass §16's signature gate for
 * free in every deploy test.
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
  /** The process every one of the three real classes ran against. */
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
 * The manual argv walk `main.go` does instead of `fs.Parse`.
 *
 * Modelled rather than replaced by a parser, because the binary's own loop is
 * what core's argv has to satisfy: `--flag value` pairs, bare `--flag` treated
 * as a boolean, and the first non-flag argument taken as the reference.
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
