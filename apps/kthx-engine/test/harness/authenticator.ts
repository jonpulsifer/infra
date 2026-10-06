/**
 * A software passkey and the browser in front of it: a P-256 keypair that emits
 * the fields `src/auth/webauthn.ts` expects from a client. Signatures are DER,
 * as a real authenticator sends them, where WebCrypto signs raw `r || s`.
 */
import { type Bytes, base64urlEncode, ES256 } from '../../src/auth/webauthn.ts';

export interface RegistrationResponse {
  readonly credentialId: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
}

export interface AssertionResponse {
  readonly credentialId: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
}

export interface Authenticator {
  readonly credentialId: string;
  /** Enrol against a challenge, as `navigator.credentials.create()` would. */
  register(
    challenge: string,
    options?: CeremonyOptions,
  ): Promise<RegistrationResponse>;
  /** Sign in against a challenge, as `navigator.credentials.get()` would. */
  assert(
    challenge: string,
    options?: CeremonyOptions,
  ): Promise<AssertionResponse>;
}

export interface CeremonyOptions {
  readonly rpId?: string;
  readonly origin?: string;
  readonly signCount?: number;
  /** `false` clears the user-present flag. */
  readonly userPresent?: boolean;
  /** `false` clears the user-verified flag. */
  readonly userVerified?: boolean;
}

export interface AuthenticatorOptions {
  readonly rpId: string;
  readonly origin: string;
}

/** `r || s` as the DER `SEQUENCE` an authenticator emits. */
function derEncode(raw: Uint8Array): Bytes {
  const half = raw.length / 2;
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = [...bytes.slice(start)];
    if ((body[0]! & 0x80) !== 0) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const parts = [...integer(raw.slice(0, half)), ...integer(raw.slice(half))];
  return new Uint8Array([0x30, parts.length, ...parts]);
}

async function authenticatorData(
  rpId: string,
  flags: number,
  signCount: number,
): Promise<Bytes> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)),
  );
  const data = new Uint8Array(37);
  data.set(rpIdHash, 0);
  data[32] = flags;
  new DataView(data.buffer).setUint32(33, signCount, false);
  return data;
}

function clientDataJSON(
  type: 'webauthn.create' | 'webauthn.get',
  challenge: string,
  origin: string,
): Bytes {
  return new TextEncoder().encode(
    JSON.stringify({ type, challenge, origin, crossOrigin: false }),
  );
}

export async function createAuthenticator(
  options: AuthenticatorOptions,
): Promise<Authenticator> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const publicKey = base64urlEncode(
    new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
  );
  const credentialId = base64urlEncode(
    crypto.getRandomValues(new Uint8Array(16)),
  );

  const ceremony = async (
    type: 'webauthn.create' | 'webauthn.get',
    challenge: string,
    given: CeremonyOptions,
  ) => {
    const flags =
      ((given.userPresent ?? true) ? 0x01 : 0) |
      ((given.userVerified ?? true) ? 0x04 : 0);
    const authData = await authenticatorData(
      given.rpId ?? options.rpId,
      flags,
      given.signCount ?? 0,
    );
    const client = clientDataJSON(
      type,
      challenge,
      given.origin ?? options.origin,
    );
    return { authData, client };
  };

  return {
    credentialId,

    async register(challenge, given = {}) {
      const { authData, client } = await ceremony(
        'webauthn.create',
        challenge,
        given,
      );
      return {
        credentialId,
        publicKey,
        algorithm: ES256,
        authenticatorData: base64urlEncode(authData),
        clientDataJSON: base64urlEncode(client),
      };
    },

    async assert(challenge, given = {}) {
      const { authData, client } = await ceremony(
        'webauthn.get',
        challenge,
        given,
      );
      const clientHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', client),
      );
      const signed = new Uint8Array(authData.length + clientHash.length);
      signed.set(authData, 0);
      signed.set(clientHash, authData.length);

      const raw = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.privateKey,
          signed,
        ),
      );

      return {
        credentialId,
        authenticatorData: base64urlEncode(authData),
        clientDataJSON: base64urlEncode(client),
        signature: base64urlEncode(derEncode(raw)),
      };
    },
  };
}
