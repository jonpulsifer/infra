/**
 * A Google that is not Google: one RSA keypair, one JWKS, and tokens signed
 * with it.
 *
 * The server verifies an ID token against whatever `Config.jwksUrl` names, so a
 * test mints its own rather than reaching the real issuer — the suite has no
 * network, and a token from Google expires in an hour anyway. The JWKS is a
 * `data:` URL, which `fetch` reads without a second server to start and stop.
 *
 * Everything here is a real signature over real base64url: the only thing this
 * fakes is which key the server was told to believe.
 */
import { base64urlEncode } from '@repo/archive/bytes';

/** gcloud's client id — the default `aud` the server accepts. */
export const AUDIENCE = '32555940559.apps.googleusercontent.com';
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

/** The published key, and one that is not published anywhere. */
const signing = await keypair();
const stray = await keypair();

async function publicJwk(pair: CryptoKeyPair, kid: string): Promise<object> {
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<
    string,
    unknown
  >;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

/** The JWKS the server fetches: the signing key, and nothing else. */
export const JWKS = JSON.stringify({
  keys: [await publicJwk(signing, KID)],
});

/** What `Config.jwksUrl` is pointed at. No port, no cleanup. */
export function jwksUrl(body: string = JWKS): string {
  return `data:application/json,${encodeURIComponent(body)}`;
}

/** A JWKS that carries a key nothing signs with — a rotation, from the far side. */
export async function rotatedJwks(): Promise<string> {
  return JSON.stringify({ keys: [await publicJwk(stray, 'kthx-test-other')] });
}

const segment = (value: unknown): string =>
  base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));

export interface Minted {
  /** Claims merged over the defaults; `undefined` drops a claim entirely. */
  readonly claims?: Record<string, unknown>;
  /** Sign with a key the JWKS does not carry. */
  readonly unpublished?: boolean;
  readonly kid?: string;
  readonly alg?: string;
}

/**
 * One ID token, signed for real.
 *
 * The defaults are a valid token for `email`; a test names only the claim it is
 * attacking.
 */
export async function idToken(
  email = 'owner@example.com',
  options: Minted = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: ISSUER,
    aud: AUDIENCE,
    azp: AUDIENCE,
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
  const head = segment({
    alg: options.alg ?? 'RS256',
    kid: options.kid ?? KID,
    typ: 'JWT',
  });
  const body = segment(claims);
  const pair = options.unpublished === true ? stray : signing;
  const signature = await crypto.subtle.sign(
    ALGORITHM.name,
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${base64urlEncode(signature)}`;
}

/** The `sub` the server will read out of a token minted for this address. */
export const subOf = (email = 'owner@example.com'): string => `sub-${email}`;
