/**
 * A Google that is not Google: one RSA keypair, one JWKS, and ID tokens signed
 * with it. The server is pointed at the JWKS as a `data:` URL, so no second
 * server runs. Everything is a real signature; only the trusted key is fake.
 */
import { base64urlEncode } from '@repo/archive/bytes';

/** The audiences the test server accepts: a service account's and gcloud's. */
export const AUDIENCE = 'https://kthx.dev';
export const GCLOUD_AUDIENCE = '32555940559.apps.googleusercontent.com';
export const ISSUER = 'https://accounts.google.com';
const KID = 'kthx-test-key';

const ALGORITHM = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
} as const;

async function keypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ALGORITHM, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

/** The published key, and one published nowhere. */
const signing = await keypair();
const stray = await keypair();

const jwk = (await crypto.subtle.exportKey('jwk', signing.publicKey)) as Record<
  string,
  unknown
>;

/** What `Config.jwksUrl` points at. */
export const JWKS_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }),
)}`;

const segment = (value: unknown): string =>
  base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

export interface Minted {
  /** Merged over the defaults; `undefined` drops a claim. */
  readonly claims?: Record<string, unknown>;
  /** Signed with a key the JWKS does not carry. */
  readonly unpublished?: boolean;
}

/** A valid ID token for `email`; a test names only the claim it attacks. */
export async function idToken(
  email = 'owner@example.com',
  options: Minted = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    azp: 'test',
    sub: `sub-${email}`,
    email,
    email_verified: true,
    iat: now,
    exp: now + 3600,
    ...options.claims,
  };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[key];
  }
  const head = segment({ alg: 'RS256', kid: KID, typ: 'JWT' });
  const body = segment(claims);
  const pair = options.unpublished === true ? stray : signing;
  const signature = await crypto.subtle.sign(
    ALGORITHM.name,
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64urlEncode(signature)}`;
}
