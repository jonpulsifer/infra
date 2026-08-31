/**
 * WebAuthn verification, with no dependency and no CBOR (Task 37).
 *
 * §"First run and identity" wants a passkey enrolled against a token that
 * shipped with the installation. That is a small amount of cryptography and a
 * large amount of format, and this file exists to keep the second from
 * requiring a parser nobody in this repo wants to own.
 *
 * **Why there is no CBOR.** The classic shape of this code parses the
 * `attestationObject` — a CBOR map wrapping the authenticator data, wrapping in
 * turn a COSE-encoded public key — which is two decoders written to read one
 * key. The browser will hand over both halves already decoded:
 * `AuthenticatorAttestationResponse.getPublicKey()` returns the key as SPKI,
 * which is what `crypto.subtle.importKey` takes, and `getAuthenticatorData()`
 * returns the authenticator data on its own. So the client sends those, and
 * what is left here is a flat binary header and a signature check.
 *
 * **Why trusting the browser's parse is sound.** It costs exactly one thing:
 * attestation is not verified. That is deliberate and it is not a shortcut —
 * §"First run" story 1 makes the *enrolment token* the trust anchor for a first
 * credential, and an attestation statement proves the make and model of an
 * authenticator, never that the person holding the token meant to enrol it. A
 * single-operator installation gets nothing from the statement it would pay a
 * CBOR parser for. Everything an attacker could gain by lying about the public
 * key here requires already holding the token, at which point they can simply
 * enrol their own.
 *
 * What *is* verified, on every ceremony: the challenge was the one this server
 * issued, the origin is this installation's, the relying party is this
 * installation's, a human was present, and — for a sign-in — the signature is
 * the credential's over exactly the bytes that were sent.
 *
 * Nothing here reads the database or the clock. The rejections are a closed
 * union for the same reason §6's failure reasons are: a refusal has to have an
 * identity a test can key on.
 */
import { type Bytes, base64urlDecode, equalBytes } from '@repo/archive/bytes';

export {
  type Bytes,
  base64urlDecode,
  base64urlEncode,
} from '@repo/archive/bytes';

/**
 * The two COSE algorithms this installation enrols.
 *
 * `-7` (ES256) is what every platform authenticator produces; `-257` (RS256) is
 * what Windows Hello has historically produced. Ed25519 (`-8`) is legal
 * WebAuthn and deliberately absent: it would be a third key-import path to keep
 * correct for no credential anyone here can currently enrol, and an algorithm
 * that arrives unsupported is refused loudly rather than handed to WebCrypto to
 * fail obscurely.
 */
export const ES256 = -7;
export const RS256 = -257;

export type WebAuthnAlgorithm = typeof ES256 | typeof RS256;

/** The algorithms offered in a `PublicKeyCredentialCreationOptions`. */
export const SUPPORTED_ALGORITHMS: readonly WebAuthnAlgorithm[] = [
  ES256,
  RS256,
];

/**
 * Why a ceremony was refused.
 *
 * Closed, and split finer than "invalid": `RELYING_PARTY_MISMATCH` and
 * `SIGNATURE_INVALID` are different events — the first is a genuine signature
 * aimed at someone else, the second is not a signature at all — and collapsing
 * them would make the one log line an operator reads say less than it knows.
 */
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

/** A ceremony either held or names why it did not. */
export type CeremonyResult =
  | { readonly ok: true; readonly signCount: number }
  | { readonly ok: false; readonly rejection: WebAuthnRejection };

type Checked =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: WebAuthnRejection };

// --- clientDataJSON ----------------------------------------------------------

export type CeremonyType = 'webauthn.create' | 'webauthn.get';

export interface ClientDataExpectation {
  readonly clientDataJSON: Bytes;
  readonly type: CeremonyType;
  /** The challenge this server issued, base64url. */
  readonly challenge: string;
  readonly origin: string;
}

/**
 * Check the three facts `clientDataJSON` carries.
 *
 * The challenge comparison is over decoded bytes rather than strings: base64url
 * has no canonical padding and a browser is entitled to differ from us on it,
 * so comparing the text would reject a correct ceremony over a `=`.
 */
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

// --- authenticatorData -------------------------------------------------------

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

/**
 * Read the header. Anything after it — attested credential data, extensions —
 * is not read, because nothing here needs it once the public key arrives
 * separately.
 */
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
 * Whether an authenticator's counter moved the way it must have.
 *
 * A synced passkey — which is what §"First run" asks the operator to enrol —
 * reports zero forever: it exists on more than one device on purpose, so there
 * is nothing for a counter to mean. Requiring the counter to advance would
 * therefore reject every passkey ever presented. The clone check only binds
 * when the authenticator is actually counting, which is the whole of what the
 * counter can honestly tell us.
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

/** What both ceremonies are checked against. */
export interface ExpectedCeremony {
  /** The challenge this server issued, base64url. */
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
}

// --- registration ------------------------------------------------------------

export interface RegistrationCeremony {
  /** `AuthenticatorAttestationResponse.getAuthenticatorData()`, base64url. */
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly expected: ExpectedCeremony;
}

/**
 * Verify an enrolment ceremony.
 *
 * Synchronous in shape but async in fact only because the relying-party check
 * hashes a string — there is no signature here to verify, by design: see this
 * module's header on why attestation is not read.
 */
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

// --- assertion ---------------------------------------------------------------

/** The stored halves of a credential an assertion is checked against. */
export interface StoredCredential {
  /** The SPKI public key the browser handed over at enrolment, base64url. */
  readonly publicKey: string;
  /** The COSE algorithm id it was enrolled with. */
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
 * Verify a sign-in ceremony, signature and all.
 *
 * The signature covers `authenticatorData || SHA-256(clientDataJSON)`, which is
 * why neither half can be swapped after the fact: re-pointing a captured
 * signature at a different relying party changes the authenticator data, and
 * replaying it against a different challenge changes the client-data hash.
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

    // ES256. An authenticator emits the DER `SEQUENCE`; WebCrypto takes raw
    // `r || s`. Converting is not optional and is the whole reason
    // {@link derToRawEcdsa} exists.
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
    // A key that will not import is a credential that cannot have made this
    // signature, which is the same answer as a signature that does not verify.
    return false;
  }
}

/** P-256: `r` and `s` are 32 bytes each once the DER framing is off. */
const P256_COORDINATE = 32;

/**
 * `SEQUENCE { INTEGER r, INTEGER s }` → `r || s`, both left-padded to 32 bytes.
 *
 * DER integers are signed and minimally encoded, so a coordinate whose top bit
 * is set gains a leading zero byte and one with leading zeroes loses them —
 * which is why this pads and trims rather than slicing at fixed offsets.
 * Returns `null` rather than throwing on anything malformed; the caller's
 * answer for both is the same.
 */
export function derToRawEcdsa(der: Bytes): Bytes | null {
  if (der.length < 8 || der[0] !== 0x30) return null;

  // The length byte is short-form for any P-256 signature (well under 128
  // bytes), so a long-form length here is not a signature we made.
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
    // Strip DER's sign byte, then reject anything still too wide to be a
    // coordinate.
    while (value.length > P256_COORDINATE && value[0] === 0) {
      value = value.slice(1);
    }
    if (value.length === 0 || value.length > P256_COORDINATE) return null;

    raw.set(value, half * P256_COORDINATE + (P256_COORDINATE - value.length));
    cursor = end;
  }

  return cursor === der.length ? raw : null;
}
