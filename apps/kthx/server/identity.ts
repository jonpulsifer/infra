/**
 * Who the caller is: a verified Google identity, or nobody.
 *
 * An owner used to be whoever held a string this server minted. That made a
 * site unattributable — the directory could say a name existed and nothing
 * else — and it made "I lost the token" the end of the story. An owner is now
 * a Google account: `gcloud auth print-identity-token` mints the credential and
 * this file checks it.
 *
 * No dependency. An ID token is three base64url parts and an RS256 signature,
 * which `crypto.subtle` verifies directly against Google's published JWKS; a
 * JWT library would be a supply-chain edge on the one path where that matters
 * most, for sixty lines of parsing. What it is not is a general JWT verifier:
 * RS256 only, one issuer set, one audience list, and every claim checked rather
 * than read.
 *
 * The keys are cached for the `max-age` the JWKS response asks for. An unknown
 * `kid` refetches once, throttled, because Google publishes a new key before it
 * signs with it and a cache that cannot learn one would lock every owner out
 * until it expired. A fetch that fails keeps serving the keys already in hand,
 * for the same reason.
 */
import { base64urlDecode } from '@repo/archive/bytes';
import type { Config } from './env.ts';
import { fromTrustedProxy, logCause } from './http.ts';
import type { Ctx } from './sites.ts';

/** A verified account. `sub` is what ownership compares; `email` is shown. */
export interface Identity {
  readonly sub: string;
  readonly email: string;
}

/** The two spellings Google puts in `iss`. */
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Clocks disagree; a minute each way is the usual allowance. */
const SKEW_MS = 60_000;
/** Longer than any ID token, and short enough that garbage is cheap. */
const MAX_TOKEN_BYTES = 8192;
/** How often an unknown `kid` may cost a fetch. */
const REFETCH_FLOOR_MS = 5 * 60_000;
/** What a JWKS with no usable `max-age` is trusted for. */
const FALLBACK_MAX_AGE_MS = 60 * 60_000;
const JWKS_TIMEOUT_MS = 5_000;

interface Keys {
  readonly byKid: ReadonlyMap<string, CryptoKey>;
  /** When this set was fetched, so an unknown `kid` can be throttled. */
  readonly at: number;
  /** When it stops being current, from the response's own `Cache-Control`. */
  readonly until: number;
}

/**
 * ponytail: process-wide, like every other cache here — one replica by
 * construction. A second replica costs a second JWKS fetch an hour and nothing
 * else, so this stays a module variable rather than a store.
 */
let keys: Keys | null = null;
let fetching: Promise<Keys> | null = null;

/** The `Bearer` credential this request carries, whatever kind it is. */
export function bearerOf(request: Request): string | null {
  return (
    /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1] ??
    null
  );
}

/**
 * The identity this request carries, or `null` when it carries none this
 * server believes.
 *
 * A credential that does not verify is the same answer as no credential: the
 * caller is told 401 or 403 by whoever asked, and the reason goes to the log.
 */
export async function identityOf(
  request: Request,
  ctx: Pick<Ctx, 'config' | 'server' | 'id'>,
): Promise<Identity | null> {
  const asserted = assertedIdentity(request, ctx.config, ctx.server);
  if (asserted !== null) return asserted;
  const token = bearerOf(request);
  // A site bearer is 32 random bytes base64url and has no dots in it, so this
  // never spends a signature check on one — nor on the `Bearer <apiKey>` the
  // OpenAI SDK puts on every `/api/ai` call.
  if (token === null || token.split('.').length !== 3) return null;
  try {
    return await verifyIdToken(token, ctx.config);
  } catch (cause) {
    logCause(ctx.id, 'verifying an id token', cause);
    return null;
  }
}

/**
 * The identity a trusted hop asserts in a header — the IAP future, off until
 * `KTHX_TRUSTED_IDENTITY_HEADER` names one.
 *
 * Two things have to hold: the deployment names the header, and the request
 * came from a peer in `KTHX_TRUSTED_PROXIES`. A header alone is worth nothing,
 * because this pod is reachable on the LAN and the tailnet as well as through
 * the Gateway — the same reason `cf-connecting-ip` is not believed on its own.
 */
export function assertedIdentity(
  request: Request,
  config: Config,
  server: Bun.Server<unknown> | undefined,
): Identity | null {
  const header = config.trustedIdentityHeader;
  if (header === null) return null;
  const raw = request.headers.get(header)?.trim();
  if (!raw) return null;
  if (!fromTrustedProxy(request, server, config.trustedProxies)) return null;
  // IAP writes `accounts.google.com:someone@example.com`; the address is the
  // whole of the identity a header can carry, so it is both fields.
  const email = raw
    .replace(/^accounts\.google\.com:/i, '')
    .trim()
    .toLowerCase();
  return email === '' ? null : { sub: email, email };
}

/** A Google ID token, or `null` when any check fails. Throws only on the JWKS. */
export async function verifyIdToken(
  token: string,
  config: Config,
): Promise<Identity | null> {
  if (token.length > MAX_TOKEN_BYTES) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head = '', body = '', signature = ''] = parts;
  const header = decodeJson(head);
  const payload = decodeJson(body);
  const bytes = base64urlDecode(signature);
  if (header === null || payload === null || bytes === null) return null;
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  const key = await keyFor(header.kid, config.jwksUrl);
  if (key === null) return null;
  const signed = new TextEncoder().encode(`${head}.${body}`);
  const good = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    bytes,
    signed,
  );
  return good ? claimsOf(payload, config) : null;
}

/** Every claim checked, none read. */
function claimsOf(
  payload: Record<string, unknown>,
  config: Config,
): Identity | null {
  const now = Date.now();
  const { iss, aud, exp, iat, sub, email } = payload;
  if (typeof iss !== 'string' || !ISSUERS.has(iss)) return null;
  // `aud` is a string on every Google ID token and an array in the spec.
  const audiences = Array.isArray(aud) ? aud : [aud];
  const named = audiences.some(
    (one) => typeof one === 'string' && config.oidcAudiences.includes(one),
  );
  if (!named) return null;
  if (typeof exp !== 'number' || exp * 1000 + SKEW_MS <= now) return null;
  if (typeof iat !== 'number' || iat * 1000 - SKEW_MS > now) return null;
  // An unverified address is not an account: Google issues one for a domain a
  // stranger can hold, and ownership is displayed by address.
  if (payload.email_verified !== true) return null;
  if (typeof sub !== 'string' || sub === '') return null;
  if (typeof email !== 'string' || email === '') return null;
  return { sub, email: email.toLowerCase() };
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

/** The public key for a `kid`, fetching once more when it is new. */
async function keyFor(kid: string, url: string): Promise<CryptoKey | null> {
  const held = await currentKeys(url, false);
  const key = held.byKid.get(kid);
  if (key !== undefined) return key;
  // A rotation puts a key in the JWKS before it signs with it, so an unknown
  // `kid` is worth exactly one fetch — throttled, or a stream of garbage
  // tokens would be a stream of requests to Google.
  if (Date.now() - held.at < REFETCH_FLOOR_MS) return null;
  return (await currentKeys(url, true)).byKid.get(kid) ?? null;
}

async function currentKeys(url: string, force: boolean): Promise<Keys> {
  const held = keys;
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
    // Google being briefly unreachable must not lock every owner out of every
    // site; the keys in hand outlive their `max-age` rather than the zone.
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
    // The JWKS carries whatever Google publishes; this verifier does RS256.
    if (alg !== undefined && alg !== 'RS256') continue;
    byKid.set(
      kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n, e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  if (byKid.size === 0) throw new Error('the jwks carries no RS256 key');
  const at = Date.now();
  return {
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

/** Drop the cached JWKS. For a test that serves its own, and for nothing else. */
export function forgetKeys(): void {
  keys = null;
  fetching = null;
}
