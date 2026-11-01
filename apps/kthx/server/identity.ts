/**
 * A Google ID token, verified with `crypto.subtle` against Google's JWKS: RS256,
 * the issuer, an audience from `KTHX_ID_AUDIENCES`, the expiry and, where the
 * token carries it, `email_verified`. The answer is the token's email, which a
 * site's marker names as its owner.
 *
 * Keys are cached for the JWKS response's `max-age`. An unknown `kid` refetches
 * once, throttled, because Google publishes a key before it signs with it. A
 * failed fetch keeps serving the keys already in hand.
 */
import { base64urlDecode } from '@repo/archive/bytes';
import type { Config } from './env.ts';

/** The two spellings Google puts in `iss`. */
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const SKEW_MS = 60_000;
/** Longer than any ID token, short enough that garbage is cheap. */
const MAX_TOKEN_BYTES = 8192;
/** How often an unknown `kid` may cost a fetch. */
const REFETCH_FLOOR_MS = 5 * 60_000;
/** What a JWKS with no usable `max-age` is trusted for. */
const FALLBACK_MAX_AGE_MS = 60 * 60_000;
const JWKS_TIMEOUT_MS = 5_000;

export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

interface Keys {
  readonly url: string;
  readonly byKid: ReadonlyMap<string, CryptoKey>;
  readonly at: number;
  readonly until: number;
}

// One replica, so a module cache is the whole cache.
let keys: Keys | null = null;
let fetching: Promise<Keys> | null = null;

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/** A dotted bearer: a site visitor's OpenAI SDK sends `Bearer <key>` to `/api/ai`. */
export function looksLikeJwt(token: string): boolean {
  return token.length <= MAX_TOKEN_BYTES && token.split('.').length === 3;
}

/**
 * The verified email, or `null` when any check fails. Throws only when the
 * JWKS cannot be read and no keys are in hand.
 */
export async function verifyIdToken(
  token: string,
  config: Pick<Config, 'idAudiences' | 'jwksUrl'>,
): Promise<string | null> {
  if (config.idAudiences.length === 0 || !looksLikeJwt(token)) return null;
  const [head = '', body = '', signature = ''] = token.split('.');
  const header = decodeJson(head);
  const payload = decodeJson(body);
  const bytes = base64urlDecode(signature);
  if (header === null || payload === null || bytes === null) return null;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  const key = await keyFor(header.kid, config.jwksUrl);
  if (key === null) return null;
  const signed = new TextEncoder().encode(`${head}.${body}`);
  if (!(await crypto.subtle.verify(RS256, key, bytes, signed))) return null;
  return emailOf(payload, config.idAudiences);
}

function emailOf(
  payload: Record<string, unknown>,
  audiences: readonly string[],
): string | null {
  const now = Date.now();
  const { iss, aud, exp, email } = payload;
  if (typeof iss !== 'string' || !ISSUERS.has(iss)) return null;
  const named = (Array.isArray(aud) ? aud : [aud]).some(
    (one) => typeof one === 'string' && audiences.includes(one),
  );
  if (!named) return null;
  if (typeof exp !== 'number' || exp * 1000 + SKEW_MS <= now) return null;
  if (typeof payload.iat === 'number' && payload.iat * 1000 - SKEW_MS > now) {
    return null;
  }
  // A service account's token may omit it; a user's says whether Google
  // verified the address.
  if ('email_verified' in payload && payload.email_verified !== true) {
    return null;
  }
  if (typeof email !== 'string' || email === '') return null;
  return email.trim().toLowerCase();
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = base64urlDecode(part);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function keyFor(kid: string, url: string): Promise<CryptoKey | null> {
  const held = await currentKeys(url, false);
  const key = held.byKid.get(kid);
  if (key !== undefined) return key;
  if (Date.now() - held.at < REFETCH_FLOOR_MS) return null;
  return (await currentKeys(url, true)).byKid.get(kid) ?? null;
}

async function currentKeys(url: string, force: boolean): Promise<Keys> {
  const held = keys?.url === url ? keys : null;
  if (!force && held !== null && Date.now() < held.until) return held;
  fetching ??= fetchKeys(url)
    .then((fresh) => {
      keys = fresh;
      return fresh;
    })
    .finally(() => {
      fetching = null;
    });
  try {
    return await fetching;
  } catch (cause) {
    // Google briefly unreachable must not lock every owner out.
    if (held !== null) return held;
    throw cause;
  }
}

async function fetchKeys(url: string): Promise<Keys> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the jwks answered ${response.status}`);
  const body = (await response.json()) as { keys?: unknown };
  const byKid = new Map<string, CryptoKey>();
  for (const entry of Array.isArray(body.keys) ? body.keys : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { kid, kty, n, e, alg } = entry as Record<string, unknown>;
    if (typeof kid !== 'string' || kty !== 'RSA') continue;
    if (typeof n !== 'string' || typeof e !== 'string') continue;
    if (alg !== undefined && alg !== 'RS256') continue;
    byKid.set(
      kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n, e, alg: 'RS256', ext: true },
        RS256,
        false,
        ['verify'],
      ),
    );
  }
  if (byKid.size === 0) throw new Error('the jwks carries no RS256 key');
  const at = Date.now();
  return {
    url,
    byKid,
    at,
    until: at + maxAge(response.headers.get('cache-control')),
  };
}

function maxAge(header: string | null): number {
  const seconds = Number(/max-age\s*=\s*(\d+)/i.exec(header ?? '')?.[1]);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : FALLBACK_MAX_AGE_MS;
}
