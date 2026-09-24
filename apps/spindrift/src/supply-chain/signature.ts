/**
 * The production {@link SignatureVerifier}: the pinned `spindrift-verifier`
 * binary's `verify-signature` subcommand, fed the recorded bundle as a file.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SignatureVerification,
  SignatureVerifier,
  VerifySignatureInput,
} from './sign.ts';
import { bunProcessExecutor, type ProcessExecutor } from './verify.ts';

export interface SpindriftSignatureVerifierOptions {
  readonly executable?: string;
  readonly processes?: ProcessExecutor;
  /**
   * The key `CosignSigner` signs with. The verifier refuses a bundle whose
   * embedded key does not match it, so any other key fails admission.
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

export type { CoreSignature } from './sign.ts';
