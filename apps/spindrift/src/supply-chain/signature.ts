/**
 * The production {@link SignatureVerifier}: the pinned `spindrift-verifier`
 * binary's `verify-signature` subcommand (§16, §19).
 *
 * Verification and signing are the same binary, so the two paths differ by a
 * process boundary, not by correctness — Go's `crypto/ed25519` would call the
 * same reference implementation anyway. This module is the process boundary
 * around the verifier half: it writes the recorded bundle to a temp file and
 * asks the binary whether it verifies against the recorded digest.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CoreSignature,
  SignatureVerification,
  SignatureVerifier,
  VerifySignatureInput,
} from './sign.ts';
import { bunProcessExecutor, type ProcessExecutor } from './verify.ts';

export interface SpindriftSignatureVerifierOptions {
  readonly executable?: string;
  readonly processes?: ProcessExecutor;
  /**
   * The trusted Spindrift signer reference — the same one `Sign` used. The
   * pinned verifier derives the expected public key from this and refuses a
   * bundle whose embedded key does not match, so admission proves
   * *Spindrift's* key signed the digest, not *some* key.
   */
  readonly signerKey: string;
}

export class SpindriftSignatureVerifier implements SignatureVerifier {
  private readonly executable: string;
  private readonly processes: ProcessExecutor;
  private readonly signerKey: string;

  constructor(options: SpindriftSignatureVerifierOptions) {
    this.executable = options.executable ?? 'spindrift-verifier';
    this.processes = options.processes ?? bunProcessExecutor;
    this.signerKey = options.signerKey;
  }

  async verify(input: VerifySignatureInput): Promise<SignatureVerification> {
    const directory = await mkdtemp(join(tmpdir(), 'spindrift-admission-'));
    const bundlePath = join(directory, 'bundle.json');
    try {
      await writeFile(bundlePath, JSON.stringify(input.signature.bundle), {
        mode: 0o600,
      });
      const result = await this.processes.run([
        this.executable,
        'verify-signature',
        '--artifact-digest',
        input.artifactDigest,
        '--bundle-path',
        bundlePath,
        // Pins admission to Spindrift's own signer: the verifier derives the
        // expected public key from this file and refuses any bundle whose
        // embedded key does not match.
        '--signer-key',
        this.signerKey,
      ]);
      if (result.exitCode === 0) return { ok: true, reason: null };
      const detail = result.stderr.trim() || result.stdout.trim();
      return {
        ok: false,
        reason:
          detail === ''
            ? 'signature did not verify against the recorded digest'
            : detail,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Re-exported so `CoreSignature` stays a single import for callers. */
export type { CoreSignature } from './sign.ts';
