/**
 * WebAuthn verification without CBOR: the browser sends the SPKI key from
 * `getPublicKey()` and the raw authenticator data. Attestation is not verified;
 * the enrolment token is what a first passkey is trusted on.
 */
import { type Bytes, base64urlDecode, equalBytes } from '@repo/archive/bytes';

export {
  type Bytes,
  base64urlDecode,
  base64urlEncode,
} from '@repo/archive/bytes';

/**
 * COSE ids: ES256 for platform authenticators, RS256 for Windows Hello. Any
 * other algorithm, Ed25519 included, is refused before it reaches WebCrypto.
 */
export const ES256 = -7;
export const RS256 = -257;

export type WebAuthnAlgorithm = typeof ES256 | typeof RS256;

export const SUPPORTED_ALGORITHMS: readonly WebAuthnAlgorithm[] = [
  ES256,
  RS256,
];

export type WebAuthnRejection =
  | 'CLIENT_DATA_MALFORMED'
  | 'CLIENT_DATA_WRONG_TYPE'
  | 'CHALLENGE_MISMATCH'
  | 'ORIGIN_MISMATCH'
  | 'AUTHENTICATOR_DATA_MALFORMED'
  | 'RELYING_PARTY_MISMATCH'
  | 'USER_NOT_PRESENT'
  | 'USER_NOT_VERIFIED'
  | 'UNSUPPORTED_ALGORITHM'
  | 'SIGNATURE_INVALID';

export type CeremonyResult =
  | { readonly ok: true; readonly signCount: number }
  | { readonly ok: false; readonly rejection: WebAuthnRejection };

type Checked =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: WebAuthnRejection };

export type CeremonyType = 'webauthn.create' | 'webauthn.get';

export interface ClientDataExpectation {
  readonly clientDataJSON: Bytes;
  readonly type: CeremonyType;
  /** The challenge this server issued, base64url. */
  readonly challenge: string;
  readonly origin: string;
}

export function verifyClientData(expectation: ClientDataExpectation): Checked {
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(expectation.clientDataJSON));
  } catch {
    return { ok: false, rejection: 'CLIENT_DATA_MALFORMED' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, rejection: 'CLIENT_DATA_MALFORMED' };
  }
  if (parsed.type !== expectation.type) {
    return { ok: false, rejection: 'CLIENT_DATA_WRONG_TYPE' };
  }
  if (
    typeof parsed.challenge !== 'string' ||
    typeof parsed.origin !== 'string'
  ) {
    return { ok: false, rejection: 'CLIENT_DATA_MALFORMED' };
  }

  // Compared as bytes: base64url padding is not canonical, so equal
  // challenges can differ as text.
  const offered = base64urlDecode(parsed.challenge);
  const issued = base64urlDecode(expectation.challenge);
  if (offered === null || issued === null || !equalBytes(offered, issued)) {
    return { ok: false, rejection: 'CHALLENGE_MISMATCH' };
  }
  if (parsed.origin !== expectation.origin) {
    return { ok: false, rejection: 'ORIGIN_MISMATCH' };
  }

  return { ok: true };
}

/** The fixed header: 32 bytes of RP hash, one of flags, four of counter. */
const AUTHENTICATOR_DATA_HEADER = 37;
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

export interface AuthenticatorData {
  readonly rpIdHash: Bytes;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly signCount: number;
}

/** Reads only the header; the public key arrives separately. */
export function parseAuthenticatorData(bytes: Bytes): AuthenticatorData | null {
  if (bytes.length < AUTHENTICATOR_DATA_HEADER) return null;
  const flags = bytes[32]!;
  return {
    rpIdHash: bytes.slice(0, 32),
    userPresent: (flags & FLAG_USER_PRESENT) !== 0,
    userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
    signCount: new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(
      0,
      false,
    ),
  };
}

/**
 * A synced passkey reports a counter of zero forever, so the clone check binds
 * only once an authenticator counts.
 */
export function isNewerSignCount(stored: number, offered: number): boolean {
  if (stored === 0 && offered === 0) return true;
  return offered > stored;
}

async function verifyCeremonyEnvelope(args: {
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly type: CeremonyType;
  readonly expected: ExpectedCeremony;
}): Promise<
  | {
      readonly ok: true;
      readonly authData: Bytes;
      readonly clientBytes: Bytes;
      readonly parsed: AuthenticatorData;
    }
  | { readonly ok: false; readonly rejection: WebAuthnRejection }
> {
  const authData = base64urlDecode(args.authenticatorData);
  if (authData === null) {
    return { ok: false, rejection: 'AUTHENTICATOR_DATA_MALFORMED' };
  }
  const parsed = parseAuthenticatorData(authData);
  if (parsed === null) {
    return { ok: false, rejection: 'AUTHENTICATOR_DATA_MALFORMED' };
  }

  const clientBytes = base64urlDecode(args.clientDataJSON);
  if (clientBytes === null) {
    return { ok: false, rejection: 'CLIENT_DATA_MALFORMED' };
  }

  const client = verifyClientData({
    clientDataJSON: clientBytes,
    type: args.type,
    challenge: args.expected.challenge,
    origin: args.expected.origin,
  });
  if (!client.ok) return client;

  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(args.expected.rpId),
    ),
  );
  if (!equalBytes(parsed.rpIdHash, rpIdHash)) {
    return { ok: false, rejection: 'RELYING_PARTY_MISMATCH' };
  }
  if (!parsed.userPresent) {
    return { ok: false, rejection: 'USER_NOT_PRESENT' };
  }
  if (!parsed.userVerified) {
    return { ok: false, rejection: 'USER_NOT_VERIFIED' };
  }

  return { ok: true, authData, clientBytes, parsed };
}

export interface ExpectedCeremony {
  /** The challenge this server issued, base64url. */
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
}

export interface RegistrationCeremony {
  /** `AuthenticatorAttestationResponse.getAuthenticatorData()`, base64url. */
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly expected: ExpectedCeremony;
}

/** Attestation is not read, so there is no signature to verify here. */
export async function verifyRegistration(
  ceremony: RegistrationCeremony,
): Promise<CeremonyResult> {
  const envelope = await verifyCeremonyEnvelope({
    authenticatorData: ceremony.authenticatorData,
    clientDataJSON: ceremony.clientDataJSON,
    type: 'webauthn.create',
    expected: ceremony.expected,
  });
  if (!envelope.ok) return envelope;
  return { ok: true, signCount: envelope.parsed.signCount };
}

export interface StoredCredential {
  /** SPKI from `getPublicKey()` at enrolment, base64url. */
  readonly publicKey: string;
  /** COSE algorithm id. */
  readonly algorithm: number;
}

export interface AssertionCeremony {
  readonly credential: StoredCredential;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
  readonly expected: ExpectedCeremony;
}

/**
 * The signature covers `authenticatorData || SHA-256(clientDataJSON)`, binding
 * it to both the relying party and the challenge.
 */
export async function verifyAssertion(
  ceremony: AssertionCeremony,
): Promise<CeremonyResult> {
  if (!isSupported(ceremony.credential.algorithm)) {
    return { ok: false, rejection: 'UNSUPPORTED_ALGORITHM' };
  }

  const envelope = await verifyCeremonyEnvelope({
    authenticatorData: ceremony.authenticatorData,
    clientDataJSON: ceremony.clientDataJSON,
    type: 'webauthn.get',
    expected: ceremony.expected,
  });
  if (!envelope.ok) return envelope;

  const signature = base64urlDecode(ceremony.signature);
  const spki = base64urlDecode(ceremony.credential.publicKey);
  if (signature === null || spki === null) {
    return { ok: false, rejection: 'SIGNATURE_INVALID' };
  }

  const clientHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', envelope.clientBytes),
  );
  const signed = new Uint8Array(envelope.authData.length + clientHash.length);
  signed.set(envelope.authData, 0);
  signed.set(clientHash, envelope.authData.length);

  const verified = await verifySignature(
    ceremony.credential.algorithm,
    spki,
    signature,
    signed,
  );
  if (!verified) return { ok: false, rejection: 'SIGNATURE_INVALID' };

  return { ok: true, signCount: envelope.parsed.signCount };
}

function isSupported(algorithm: number): algorithm is WebAuthnAlgorithm {
  return SUPPORTED_ALGORITHMS.includes(algorithm as WebAuthnAlgorithm);
}

async function verifySignature(
  algorithm: WebAuthnAlgorithm,
  spki: Bytes,
  signature: Bytes,
  signed: Bytes,
): Promise<boolean> {
  try {
    if (algorithm === RS256) {
      const key = await crypto.subtle.importKey(
        'spki',
        spki,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
      return await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        signature,
        signed,
      );
    }

    // Authenticators emit DER; WebCrypto verifies ES256 as raw `r || s`.
    const raw = derToRawEcdsa(signature);
    if (raw === null) return false;

    const key = await crypto.subtle.importKey(
      'spki',
      spki,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      raw,
      signed,
    );
  } catch {
    // A key that will not import cannot have made this signature.
    return false;
  }
}

/** P-256 `r` and `s` are 32 bytes each once the DER framing is off. */
const P256_COORDINATE = 32;

/**
 * DER `SEQUENCE { INTEGER r, INTEGER s }` to raw `r || s`. DER integers are
 * signed and minimal, so each may carry a zero sign byte or lack leading zeros.
 */
export function derToRawEcdsa(der: Bytes): Bytes | null {
  if (der.length < 8 || der[0] !== 0x30) return null;

  // A P-256 signature is under 128 bytes, so its DER length is short-form.
  if (der[1]! !== der.length - 2) return null;

  const raw = new Uint8Array(P256_COORDINATE * 2);
  let cursor = 2;

  for (const half of [0, 1]) {
    if (der[cursor] !== 0x02) return null;
    const length = der[cursor + 1]!;
    const start = cursor + 2;
    const end = start + length;
    if (end > der.length) return null;

    let value = der.slice(start, end);
    while (value.length > P256_COORDINATE && value[0] === 0) {
      value = value.slice(1);
    }
    if (value.length === 0 || value.length > P256_COORDINATE) return null;

    raw.set(value, half * P256_COORDINATE + (P256_COORDINATE - value.length));
    cursor = end;
  }

  return cursor === der.length ? raw : null;
}
