/**
 * The WebAuthn crypto under enrolment and sign-in, driven by keypairs minted in
 * the test. ECDSA signatures are DER-encoded, as an authenticator emits them.
 */
import { describe, expect, test } from 'bun:test';
import {
  type Bytes,
  base64urlDecode,
  base64urlEncode,
  isNewerSignCount,
  parseAuthenticatorData,
  verifyAssertion,
  verifyClientData,
  verifyRegistration,
} from '../../src/auth/webauthn.ts';

const RP_ID = 'spindrift.example.test';
const ORIGIN = `https://${RP_ID}`;

/** The `r || s` WebCrypto emits, as the DER `SEQUENCE` an authenticator emits. */
function derEncode(raw: Bytes): Bytes {
  const half = raw.length / 2;
  const integer = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const body = [...bytes.slice(start)];
    // DER integers are signed, so a leading 1 bit needs a zero byte in front.
    if ((body[0]! & 0x80) !== 0) body.unshift(0);
    return [0x02, body.length, ...body];
  };
  const parts = [...integer(raw.slice(0, half)), ...integer(raw.slice(half))];
  return new Uint8Array([0x30, parts.length, ...parts]);
}

/** `authenticatorData`: 32-byte RP hash, flags, then a 4-byte counter. */
async function authenticatorData(
  options: {
    rpId?: string;
    userPresent?: boolean;
    userVerified?: boolean;
    signCount?: number;
  } = {},
): Promise<Bytes> {
  const rpIdHash = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(options.rpId ?? RP_ID),
    ),
  );
  const flags =
    ((options.userPresent ?? true) ? 0x01 : 0) |
    ((options.userVerified ?? true) ? 0x04 : 0);
  const data = new Uint8Array(37);
  data.set(rpIdHash, 0);
  data[32] = flags;
  new DataView(data.buffer).setUint32(33, options.signCount ?? 0, false);
  return data;
}

function clientData(
  options: { type?: string; challenge?: string; origin?: string } = {},
): Bytes {
  return new TextEncoder().encode(
    JSON.stringify({
      type: options.type ?? 'webauthn.get',
      challenge:
        options.challenge ?? base64urlEncode(new Uint8Array([1, 2, 3])),
      origin: options.origin ?? ORIGIN,
      crossOrigin: false,
    }),
  );
}

/** A credential, and a signer that emits what a browser would pass on. */
async function credentialOf(algorithm: -7 | -257) {
  const params =
    algorithm === -7
      ? ({ name: 'ECDSA', namedCurve: 'P-256' } as const)
      : ({
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        } as const);

  const pair = (await crypto.subtle.generateKey(params, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;

  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey('spki', pair.publicKey),
  );

  return {
    credential: { publicKey: base64urlEncode(publicKey), algorithm },
    async sign(authData: Bytes, client: Bytes): Promise<string> {
      const clientHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', client),
      );
      const signed = new Uint8Array(authData.length + clientHash.length);
      signed.set(authData, 0);
      signed.set(clientHash, authData.length);

      const raw = new Uint8Array(
        await crypto.subtle.sign(
          algorithm === -7
            ? { name: 'ECDSA', hash: 'SHA-256' }
            : { name: 'RSASSA-PKCS1-v1_5' },
          pair.privateKey,
          signed,
        ),
      );
      // WebCrypto emits ECDSA as raw `r || s`; PKCS#1 v1.5 needs no conversion.
      return base64urlEncode(algorithm === -7 ? derEncode(raw) : raw);
    },
  };
}

describe('base64url', () => {
  test('round-trips bytes that need padding stripped', () => {
    for (const length of [1, 2, 3, 4, 32, 37, 64]) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect([...base64urlDecode(base64urlEncode(bytes))!]).toEqual([...bytes]);
    }
  });

  test('emits no character that would need escaping in a URL', () => {
    const encoded = base64urlEncode(crypto.getRandomValues(new Uint8Array(96)));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test('refuses input that is not base64url rather than returning garbage', () => {
    // Empty bytes from a failed decode would compare equal to another failure.
    expect(base64urlDecode('not base64!')).toBeNull();
  });
});

describe('client data', () => {
  const challenge = base64urlEncode(new Uint8Array([9, 8, 7]));

  test('accepts the ceremony it was issued for', () => {
    const result = verifyClientData({
      clientDataJSON: clientData({ challenge }),
      type: 'webauthn.get',
      challenge,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: true });
  });

  test('refuses a challenge that is not the one issued', () => {
    // Only the challenge prevents a replay; the rest of a ceremony is public.
    const result = verifyClientData({
      clientDataJSON: clientData({ challenge }),
      type: 'webauthn.get',
      challenge: base64urlEncode(new Uint8Array([1, 1, 1])),
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, rejection: 'CHALLENGE_MISMATCH' });
  });

  test('refuses another origin', () => {
    const result = verifyClientData({
      clientDataJSON: clientData({ challenge, origin: 'https://evil.example' }),
      type: 'webauthn.get',
      challenge,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, rejection: 'ORIGIN_MISMATCH' });
  });

  test('refuses a registration response offered as a sign-in', () => {
    // A `create` response carries no user gesture for the `get` that was asked.
    const result = verifyClientData({
      clientDataJSON: clientData({ challenge, type: 'webauthn.create' }),
      type: 'webauthn.get',
      challenge,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, rejection: 'CLIENT_DATA_WRONG_TYPE' });
  });

  test('refuses a body that is not the JSON it must be', () => {
    const result = verifyClientData({
      clientDataJSON: new TextEncoder().encode('{'),
      type: 'webauthn.get',
      challenge,
      origin: ORIGIN,
    });
    expect(result).toEqual({ ok: false, rejection: 'CLIENT_DATA_MALFORMED' });
  });
});

describe('authenticator data', () => {
  test('reads the flags and the counter', async () => {
    const parsed = parseAuthenticatorData(
      await authenticatorData({ signCount: 42 }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.userPresent).toBe(true);
    expect(parsed?.userVerified).toBe(true);
    expect(parsed?.signCount).toBe(42);
  });

  test('refuses a buffer too short to hold the fixed header', () => {
    expect(parseAuthenticatorData(new Uint8Array(36))).toBeNull();
  });
});

describe('sign counts', () => {
  // A synced passkey reports a counter of zero forever, so the clone check
  // binds only when both sides count.
  test('a counter that never moves is a passkey, not a clone', () => {
    expect(isNewerSignCount(0, 0)).toBe(true);
  });

  test('a counter that advances is accepted', () => {
    expect(isNewerSignCount(5, 6)).toBe(true);
  });

  test('a counting authenticator that goes backwards is refused', () => {
    expect(isNewerSignCount(6, 5)).toBe(false);
    expect(isNewerSignCount(6, 6)).toBe(false);
  });
});

describe.each([
  ['ES256', -7 as const],
  ['RS256', -257 as const],
])('an assertion signed with %s', (_name, algorithm) => {
  test('verifies against the credential that made it', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { credential, sign } = await credentialOf(algorithm);
    const authData = await authenticatorData({ signCount: 3 });
    const client = clientData({ challenge });

    const result = await verifyAssertion({
      credential,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(client),
      signature: await sign(authData, client),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    expect(result).toEqual({ ok: true, signCount: 3 });
  });

  test('is refused when the signature is another credential’s', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const mine = await credentialOf(algorithm);
    const theirs = await credentialOf(algorithm);
    const authData = await authenticatorData();
    const client = clientData({ challenge });

    const result = await verifyAssertion({
      credential: mine.credential,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(client),
      signature: await theirs.sign(authData, client),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    expect(result).toEqual({ ok: false, rejection: 'SIGNATURE_INVALID' });
  });

  test('is refused when the signed authenticator data is not the one sent', async () => {
    // The signature covers `authenticatorData || SHA-256(clientDataJSON)`, so
    // swapping either half after signing must break it.
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { credential, sign } = await credentialOf(algorithm);
    const client = clientData({ challenge });
    const signature = await sign(await authenticatorData(), client);

    const result = await verifyAssertion({
      credential,
      authenticatorData: base64urlEncode(
        await authenticatorData({ signCount: 99 }),
      ),
      clientDataJSON: base64urlEncode(client),
      signature,
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    expect(result).toEqual({ ok: false, rejection: 'SIGNATURE_INVALID' });
  });

  test('is refused when it was made for another relying party', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { credential, sign } = await credentialOf(algorithm);
    const authData = await authenticatorData({ rpId: 'evil.example' });
    const client = clientData({ challenge });

    const result = await verifyAssertion({
      credential,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(client),
      signature: await sign(authData, client),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    // The signature is genuine, so the rejection names the relying party.
    expect(result).toEqual({
      ok: false,
      rejection: 'RELYING_PARTY_MISMATCH',
    });
  });

  test('is refused when nobody touched the authenticator', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { credential, sign } = await credentialOf(algorithm);
    const authData = await authenticatorData({ userPresent: false });
    const client = clientData({ challenge });

    const result = await verifyAssertion({
      credential,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(client),
      signature: await sign(authData, client),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    expect(result).toEqual({ ok: false, rejection: 'USER_NOT_PRESENT' });
  });

  test('is refused when the authenticator did not verify its user', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { credential, sign } = await credentialOf(algorithm);
    const authData = await authenticatorData({ userVerified: false });
    const client = clientData({ challenge });

    const result = await verifyAssertion({
      credential,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(client),
      signature: await sign(authData, client),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    expect(result).toEqual({ ok: false, rejection: 'USER_NOT_VERIFIED' });
  });
});

describe('an algorithm outside the two supported', () => {
  test('is refused rather than passed to WebCrypto', async () => {
    // Ed25519 (-8) is legal WebAuthn, but enrolment never offers it.
    const challenge = base64urlEncode(new Uint8Array([4, 5, 6]));
    const result = await verifyAssertion({
      credential: {
        publicKey: base64urlEncode(new Uint8Array(32)),
        algorithm: -8,
      },
      authenticatorData: base64urlEncode(await authenticatorData()),
      clientDataJSON: base64urlEncode(clientData({ challenge })),
      signature: base64urlEncode(new Uint8Array(64)),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });

    expect(result).toEqual({ ok: false, rejection: 'UNSUPPORTED_ALGORITHM' });
  });
});

describe('registration', () => {
  // Registration verifies the ceremony, not an attestation: the trust anchor is
  // the shipped enrolment token, so the browser-parsed SPKI key is enough.
  test('accepts a ceremony that matches the challenge it was issued', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const result = await verifyRegistration({
      authenticatorData: base64urlEncode(await authenticatorData()),
      clientDataJSON: base64urlEncode(
        clientData({ challenge, type: 'webauthn.create' }),
      ),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });
    expect(result).toEqual({ ok: true, signCount: 0 });
  });

  test('refuses a sign-in response offered as an enrolment', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const result = await verifyRegistration({
      authenticatorData: base64urlEncode(await authenticatorData()),
      clientDataJSON: base64urlEncode(
        clientData({ challenge, type: 'webauthn.get' }),
      ),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });
    expect(result).toEqual({ ok: false, rejection: 'CLIENT_DATA_WRONG_TYPE' });
  });

  test('refuses a ceremony for another relying party', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const result = await verifyRegistration({
      authenticatorData: base64urlEncode(
        await authenticatorData({ rpId: 'evil.example' }),
      ),
      clientDataJSON: base64urlEncode(
        clientData({ challenge, type: 'webauthn.create' }),
      ),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });
    expect(result).toEqual({ ok: false, rejection: 'RELYING_PARTY_MISMATCH' });
  });

  test('refuses a credential that did not verify its user', async () => {
    const challenge = base64urlEncode(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const result = await verifyRegistration({
      authenticatorData: base64urlEncode(
        await authenticatorData({ userVerified: false }),
      ),
      clientDataJSON: base64urlEncode(
        clientData({ challenge, type: 'webauthn.create' }),
      ),
      expected: { challenge, origin: ORIGIN, rpId: RP_ID },
    });
    expect(result).toEqual({ ok: false, rejection: 'USER_NOT_VERIFIED' });
  });
});
