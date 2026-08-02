/**
 * The small encryption boundary for durable connector credentials.
 *
 * This is intentionally KMS-lite rather than a general cryptography service:
 * one installation Secret supplies a versioned keyring, one key is active,
 * legacy keys decrypt only, and callers name the purpose of every envelope.
 * Rotation is additive—install a new active key while retaining the old key,
 * then reads opportunistically rewrite old ciphertext.
 */
import { z } from 'zod';
import { base64urlDecode, base64urlEncode } from '../auth/bytes.ts';

export const CREDENTIAL_KEYRING_VAR = 'SPINDRIFT_CREDENTIAL_KEYRING';

export type CredentialPurpose =
  | 'spindrift-github-device-code'
  | 'spindrift-github-oauth-credential'
  /** A registry push credential — see `storage/registry-credentials.ts`. */
  | 'spindrift-registry-credential';

const keyId = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'must use letters, numbers, dot, dash, or underscore',
  );

const keyringDocument = z
  .object({
    active: keyId,
    keys: z.record(keyId, z.string().min(1)),
  })
  .strict();

const envelopeDocument = z
  .object({
    version: z.literal(1),
    keyId,
    nonce: z.string(),
    ciphertext: z.string(),
  })
  .strict();

/** Configuration is refused at construction rather than on the first build. */
export class CredentialKeyringConfigError extends Error {
  override readonly name = 'CredentialKeyringConfigError';
}

/** Ciphertext or key selection failed. The message never contains plaintext. */
export class CredentialDecryptError extends Error {
  override readonly name = 'CredentialDecryptError';
}

interface KeyMaterial {
  readonly bytes: Uint8Array<ArrayBuffer>;
  imported: Promise<CryptoKey> | null;
}

export interface OpenedCredential {
  readonly plaintext: string;
  /** True when the envelope should be sealed again with the active key. */
  readonly needsRotation: boolean;
}

const NONCE_BYTES = 12;
const KEY_BYTES = 32;

function aad(purpose: CredentialPurpose, key: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `spindrift:credential-envelope:v1:${purpose}:${key}`,
  );
}

function decodeKey(id: string, encoded: string): Uint8Array<ArrayBuffer> {
  const bytes = base64urlDecode(encoded);
  if (bytes === null || bytes.length !== KEY_BYTES) {
    throw new CredentialKeyringConfigError(
      `credential key ${id} must be ${KEY_BYTES} base64url-encoded bytes`,
    );
  }
  return bytes;
}

/**
 * A parsed keyring.
 *
 * Imported WebCrypto keys are cached inside this object; plaintext credentials
 * are not. Both processes construct their own keyring from the same Secret.
 */
export class CredentialKeyring {
  private constructor(
    readonly activeKeyId: string,
    private readonly keys: ReadonlyMap<string, KeyMaterial>,
  ) {}

  static fromEnvironment(
    env: Record<string, string | undefined> = Bun.env,
  ): CredentialKeyring | null {
    const raw = env[CREDENTIAL_KEYRING_VAR]?.trim();
    if (!raw) return null;

    let input: unknown;
    try {
      input = JSON.parse(raw);
    } catch {
      throw new CredentialKeyringConfigError(
        `${CREDENTIAL_KEYRING_VAR} must be a JSON keyring`,
      );
    }

    const parsed = keyringDocument.safeParse(input);
    if (!parsed.success) {
      throw new CredentialKeyringConfigError(
        `${CREDENTIAL_KEYRING_VAR} is invalid: ${z.prettifyError(parsed.error)}`,
      );
    }
    if (!(parsed.data.active in parsed.data.keys)) {
      throw new CredentialKeyringConfigError(
        `${CREDENTIAL_KEYRING_VAR} active key is absent from keys`,
      );
    }

    const keys = new Map<string, KeyMaterial>();
    for (const [id, encoded] of Object.entries(parsed.data.keys)) {
      keys.set(id, { bytes: decodeKey(id, encoded), imported: null });
    }
    return new CredentialKeyring(parsed.data.active, keys);
  }

  async seal(plaintext: string, purpose: CredentialPurpose): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce,
        additionalData: aad(purpose, this.activeKeyId),
      },
      await this.key(this.activeKeyId),
      new TextEncoder().encode(plaintext),
    );

    return JSON.stringify({
      version: 1,
      keyId: this.activeKeyId,
      nonce: base64urlEncode(nonce),
      ciphertext: base64urlEncode(ciphertext),
    });
  }

  async open(
    serialized: string,
    purpose: CredentialPurpose,
  ): Promise<OpenedCredential> {
    let input: unknown;
    try {
      input = JSON.parse(serialized);
    } catch {
      throw new CredentialDecryptError('credential envelope is not JSON');
    }
    const parsed = envelopeDocument.safeParse(input);
    if (!parsed.success) {
      throw new CredentialDecryptError('credential envelope is malformed');
    }

    const material = this.keys.get(parsed.data.keyId);
    const nonce = base64urlDecode(parsed.data.nonce);
    const ciphertext = base64urlDecode(parsed.data.ciphertext);
    if (
      material === undefined ||
      nonce === null ||
      nonce.length !== NONCE_BYTES ||
      ciphertext === null
    ) {
      throw new CredentialDecryptError(
        'credential envelope cannot be opened by this keyring',
      );
    }

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: nonce,
          additionalData: aad(purpose, parsed.data.keyId),
        },
        await this.key(parsed.data.keyId),
        ciphertext,
      );
      return {
        plaintext: new TextDecoder().decode(plaintext),
        needsRotation: parsed.data.keyId !== this.activeKeyId,
      };
    } catch {
      throw new CredentialDecryptError(
        'credential envelope authentication failed',
      );
    }
  }

  private key(id: string): Promise<CryptoKey> {
    const material = this.keys.get(id);
    if (material === undefined) {
      throw new CredentialDecryptError(`credential key ${id} is unavailable`);
    }
    material.imported ??= crypto.subtle.importKey(
      'raw',
      material.bytes,
      'AES-GCM',
      false,
      ['encrypt', 'decrypt'],
    );
    return material.imported;
  }
}
