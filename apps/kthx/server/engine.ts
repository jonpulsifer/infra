/**
 * `/api/engine/*`: the kthx engine's read of every site and its name
 * reservations. It answers on the control host only, to a projected
 * ServiceAccount token whose issuer, audience and subject the config names.
 * The engine never carries a login, so nothing here opens a site or the zone.
 */
import { type Bytes, base64urlDecode } from '@repo/archive/bytes';
import type { SQL } from 'bun';
import type { EngineConfig } from './env.ts';
import {
  bodyWithin,
  isJson,
  logCause,
  ok,
  problem,
  refuse,
  siteUrl,
} from './http.ts';
import { nameProblem } from './names.ts';
import {
  type Ctx,
  type EngineSite,
  listSitesForEngine,
  NAME_LOCK,
  report,
  siteForEngine,
} from './sites.ts';

/** Matches the token's `expirationSeconds`. */
export const KEYS_TTL_MS = 60 * 60 * 1000;
/** How long a key set outlives failed reloads before every token is a 503. */
export const KEYS_STALE_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` reloads the keys at most this often. */
export const KID_RELOAD_MS = 60 * 1000;
/** After a failed load, so a down issuer does not cost every request a fetch. */
export const FAILED_RELOAD_MS = 10 * 1000;
/**
 * How long a request holding a set past {@link KEYS_TTL_MS} waits on its
 * reload before it verifies with that set. Well under the engine's client
 * timeouts, so a hung issuer never makes held keys look like an outage.
 */
export const RELOAD_WAIT_MS = 1000;
const FETCH_MS = 5000;
const MAX_ISSUER_BYTES = 64 * 1024;
/** Either side of `exp` and `nbf`. */
const SKEW_SECONDS = 30;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export type Verdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'NOT_ENGINE' | 'ISSUER_UNREACHABLE';
      /** The check that failed, for the log only. */
      readonly check: string;
      readonly claims?: Readonly<Record<'kid' | 'iss' | 'sub', unknown>>;
    };

const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

/**
 * The issuer's signing keys, loaded from its discovery document. A load
 * replaces the whole set, so a key the issuer retires stops verifying within
 * {@link KEYS_TTL_MS}.
 */
export class EngineKeys {
  readonly #engine: EngineConfig;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  #keys: Map<string, CryptoKey> | null = null;
  #loadedAt = Number.NEGATIVE_INFINITY;
  #retryAt = Number.NEGATIVE_INFINITY;
  #kidReloadAt = Number.NEGATIVE_INFINITY;
  #loading: Promise<void> | null = null;
  #failed = false;

  constructor(
    engine: EngineConfig,
    options: { fetch?: Fetch; now?: () => number } = {},
  ) {
    this.#engine = engine;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /** Starts a load without waiting for it, so the first request finds keys. */
  warm(): void {
    void this.#load();
  }

  async verify(bearer: string | null): Promise<Verdict> {
    if (bearer === null) return refused('bearer');
    const [head, body, signature, extra] = bearer.split('.');
    if (
      head === undefined ||
      body === undefined ||
      signature === undefined ||
      extra !== undefined
    ) {
      return refused('shape');
    }
    const header = jsonOf(head);
    const claims = jsonOf(body);
    const sig = base64urlDecode(signature);
    if (header === null || claims === null || sig === null) {
      return refused('shape');
    }
    const seen = { kid: header.kid, iss: claims.iss, sub: claims.sub };
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      return refused('alg', seen);
    }
    const key = await this.#keyFor(header.kid);
    if (key === 'unreachable') {
      return {
        ok: false,
        code: 'ISSUER_UNREACHABLE',
        check: 'issuer',
        claims: seen,
      };
    }
    if (key === 'unknown') return refused('kid', seen);
    const signed = new TextEncoder().encode(`${head}.${body}`);
    if (!(await crypto.subtle.verify(RS256, key, sig, signed))) {
      return refused('signature', seen);
    }
    const now = this.#now() / 1000;
    const { aud, exp, nbf } = claims;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (claims.iss !== this.#engine.issuer) return refused('iss', seen);
    if (!audiences.includes(this.#engine.audience)) return refused('aud', seen);
    if (claims.sub !== this.#engine.subject) return refused('sub', seen);
    if (typeof exp !== 'number' || exp <= now - SKEW_SECONDS) {
      return refused('exp', seen);
    }
    if (
      nbf !== undefined &&
      (typeof nbf !== 'number' || nbf > now + SKEW_SECONDS)
    ) {
      return refused('nbf', seen);
    }
    return { ok: true };
  }

  async #keyFor(kid: string): Promise<CryptoKey | 'unknown' | 'unreachable'> {
    let keys = await this.#current();
    if (keys === null) return 'unreachable';
    if (!keys.has(kid) && this.#now() - this.#kidReloadAt >= KID_RELOAD_MS) {
      this.#kidReloadAt = this.#now();
      await this.#load();
      keys = this.#usable();
      if (keys === null) return 'unreachable';
    }
    return keys.get(kid) ?? 'unknown';
  }

  async #current(): Promise<Map<string, CryptoKey> | null> {
    const now = this.#now();
    const held = this.#usable();
    const due = held === null || now - this.#loadedAt >= KEYS_TTL_MS;
    if (due && (this.#loading !== null || now >= this.#retryAt)) {
      const load = this.#load();
      if (held === null) await load;
      // A healthy issuer answers inside the wait, so a retired key stops at
      // the TTL; one that just failed is not waited on at all.
      else if (!this.#failed)
        await Promise.race([load, Bun.sleep(RELOAD_WAIT_MS)]);
    }
    return this.#usable();
  }

  #usable(): Map<string, CryptoKey> | null {
    if (this.#keys !== null && this.#now() - this.#loadedAt >= KEYS_STALE_MS) {
      this.#keys = null;
    }
    return this.#keys;
  }

  /** One load at a time; every caller shares the one in flight. */
  #load(): Promise<void> {
    this.#loading ??= this.#read()
      .then(
        (keys) => {
          this.#keys = keys;
          this.#loadedAt = this.#now();
          this.#failed = false;
        },
        (cause: unknown) => {
          this.#failed = true;
          this.#retryAt = this.#now() + FAILED_RELOAD_MS;
          logCause('engine', 'loading the engine issuer keys', cause);
        },
      )
      .finally(() => {
        this.#loading = null;
      });
    return this.#loading;
  }

  async #read(): Promise<Map<string, CryptoKey>> {
    const issuer = this.#engine.issuer;
    const discovery = await this.#json(
      `${issuer}/.well-known/openid-configuration`,
    );
    if (discovery.issuer !== issuer) {
      throw new Error('the discovery document names another issuer');
    }
    if (typeof discovery.jwks_uri !== 'string') {
      throw new Error('the discovery document has no jwks_uri');
    }
    // `origin` carries the scheme, so an https issuer cannot point at http.
    const jwksUri = new URL(discovery.jwks_uri);
    if (jwksUri.origin !== new URL(issuer).origin) {
      throw new Error('jwks_uri is not on the issuer origin');
    }
    const jwks = await this.#json(jwksUri.href);
    const keys = new Map<string, CryptoKey>();
    for (const jwk of Array.isArray(jwks.keys) ? jwks.keys : []) {
      if (typeof jwk !== 'object' || jwk === null) continue;
      const { kty, kid, alg, use, n, e } = jwk as Record<string, unknown>;
      if (kty !== 'RSA' || typeof kid !== 'string') continue;
      if (alg !== undefined && alg !== 'RS256') continue;
      if (use !== undefined && use !== 'sig') continue;
      if (typeof n !== 'string' || typeof e !== 'string') continue;
      const imported = await crypto.subtle
        .importKey('jwk', { kty, n, e }, RS256, false, ['verify'])
        .catch(() => null);
      if (imported !== null) keys.set(kid, imported);
    }
    // An issuer serving no key can sign nothing: that is an outage, not a
    // rotation, so the last good set stays.
    if (keys.size === 0) throw new Error('the JWKS has no RS256 signing key');
    return keys;
  }

  async #json(url: string): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, {
      signal: AbortSignal.timeout(FETCH_MS),
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${url} answered ${response.status}`);
    }
    const bytes = await within(response, MAX_ISSUER_BYTES);
    if (bytes === null)
      throw new Error(`${url} is over ${MAX_ISSUER_BYTES} bytes`);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${url} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }
}

function refused(
  check: string,
  claims?: Readonly<Record<'kid' | 'iss' | 'sub', unknown>>,
): Verdict {
  return claims === undefined
    ? { ok: false, code: 'NOT_ENGINE', check }
    : { ok: false, code: 'NOT_ENGINE', check, claims };
}

function jsonOf(segment: string): Record<string, unknown> | null {
  const bytes = base64urlDecode(segment);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `null` past `maxBytes`. */
async function within(
  response: Response,
  maxBytes: number,
): Promise<Bytes | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return new Uint8Array(Buffer.concat(parts));
}

/** At most this much of an unverified claim reaches the log, quoted. */
function logged(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value.slice(0, 128)) : '-';
}

/** A DNS label: what an engine hostname puts in front of the zone. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const HOLDER = /^[a-z0-9-]{1,64}$/;
const MAX_RESERVE_BYTES = 16 * 1024;
const RESERVE_BODY_MS = 10_000;
const MAX_RESERVE_NAMES = 32;
export const ENGINE_PAGE = 50;
export const MAX_ENGINE_PAGE = 200;

function isLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 63 && LABEL.test(value);
}

function isHolder(value: unknown): value is string {
  return typeof value === 'string' && HOLDER.test(value);
}

/** `segments` is the split pathname, starting `['', 'api', 'engine']`. */
export async function engineApi(
  request: Request,
  ctx: Ctx,
  segments: readonly string[],
): Promise<Response> {
  if (ctx.engine === null || ctx.caller.door !== 'control') {
    return refuse('NOT_FOUND', ctx.id);
  }
  // No browser has a reason to be here.
  if (request.headers.has('origin')) return refuse('FORBIDDEN', ctx.id);
  const verdict = await ctx.engine.verify(ctx.caller.bearer);
  if (!verdict.ok) {
    const claims = verdict.claims;
    const seen =
      claims === undefined
        ? ''
        : ` kid=${logged(claims.kid)} iss=${logged(claims.iss)} sub=${logged(claims.sub)}`;
    logCause(ctx.id, 'the engine credential', `${verdict.check} failed${seen}`);
    return refuse(verdict.code, ctx.id);
  }

  const [, , , collection, item, extra] = segments;
  const method = request.method;
  if (collection === 'sites' && item === undefined) {
    return method === 'GET'
      ? list(request, ctx)
      : refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (collection === 'sites' && item !== '' && extra === undefined) {
    return method === 'GET'
      ? detail(ctx, item ?? '')
      : refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  if (collection === 'reservations' && item === undefined) {
    if (method === 'POST') return reserve(request, ctx);
    if (method === 'DELETE') return release(request, ctx);
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  return refuse('NOT_FOUND', ctx.id);
}

function listed(ctx: Ctx, row: EngineSite): Record<string, unknown> {
  return {
    name: row.name,
    url: siteUrl(ctx.config.zone, row.name, ctx.port),
    owner: row.owner_login,
    serving: row.serving,
    held: row.held,
    created: row.created_at.toISOString(),
    deployed: row.deployed?.toISOString() ?? null,
    provisioned: row.provisioned,
  };
}

async function list(request: Request, ctx: Ctx): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const after = query.get('after');
  if (after !== null && nameProblem(after) === 'INVALID_NAME') {
    return refuse('INVALID_QUERY', ctx.id);
  }
  // An empty `?limit=` means the default, not zero.
  const raw = query.get('limit');
  const asked = raw ? Number(raw) : ENGINE_PAGE;
  const limit = Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), MAX_ENGINE_PAGE)
    : ENGINE_PAGE;
  const page = await listSitesForEngine(ctx, limit, after);
  return ok(
    {
      total: page.total,
      items: page.rows.map((row) => listed(ctx, row)),
      next: page.next,
    },
    ctx.id,
  );
}

async function detail(ctx: Ctx, segment: string): Promise<Response> {
  let name: string;
  try {
    name = decodeURIComponent(segment);
  } catch {
    return refuse('NO_SITE', ctx.id);
  }
  const row = await siteForEngine(ctx, name);
  if (row === undefined) return refuse('NO_SITE', ctx.id);
  if (row.deleted_at !== null) return refuse('GONE', ctx.id);
  return ok({ ...listed(ctx, row), ...(await report(ctx, row)) }, ctx.id);
}

interface Taken {
  readonly name: string;
  readonly by: 'site' | 'app';
}

async function reserve(request: Request, ctx: Ctx): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  let bytes: Uint8Array | null;
  try {
    bytes = await bodyWithin(request, RESERVE_BODY_MS, MAX_RESERVE_BYTES);
  } catch (cause) {
    logCause(ctx.id, 'reading a reservation', cause);
    return refuse('TIMEOUT', ctx.id);
  }
  if (bytes === null) return refuse('TOO_LARGE', ctx.id);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refuse('MALFORMED_REQUEST', ctx.id);
  }
  const { holder, names } = (
    typeof body === 'object' && body !== null ? body : {}
  ) as Record<string, unknown>;
  if (
    !isHolder(holder) ||
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length > MAX_RESERVE_NAMES ||
    !names.every(isLabel) ||
    new Set(names).size !== names.length
  ) {
    return refuse('MALFORMED_REQUEST', ctx.id);
  }
  const sorted = [...names].sort();

  // `tx` throughout: a statement on `ctx.sql` would wait on a pool this
  // transaction may be holding the last connection of.
  const taken = await ctx.sql.begin(async (tx: SQL) => {
    const conflicts: Taken[] = [];
    for (const name of sorted) {
      // Its own statement, so the reads after it see what a racing claim or
      // reservation committed while this waited.
      await tx`select pg_advisory_xact_lock(${NAME_LOCK}::int, hashtext(${name}))`;
      // A deleted site keeps its name until the nuke, so it conflicts too.
      const [site] = (await tx`
        select 1 as site from sites where name = ${name} limit 1
      `) as { site: number }[];
      if (site !== undefined) {
        conflicts.push({ name, by: 'site' });
        continue;
      }
      const [held] = (await tx`
        select holder from reservations where name = ${name} limit 1
      `) as { holder: string }[];
      if (held !== undefined && held.holder !== holder) {
        conflicts.push({ name, by: 'app' });
      }
    }
    if (conflicts.length > 0) return conflicts;
    for (const name of sorted) {
      await tx`
        insert into reservations (name, holder) values (${name}, ${holder})
        on conflict (name) do nothing
      `;
    }
    return conflicts;
  });
  if (taken.length > 0) {
    return ok({ ...problem('TAKEN'), taken }, ctx.id, 409);
  }
  return ok({ holder, names: sorted }, ctx.id);
}

async function release(request: Request, ctx: Ctx): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const holder = query.get('holder');
  const names = query.getAll('name');
  if (!isHolder(holder) || !names.every(isLabel)) {
    return refuse('INVALID_QUERY', ctx.id);
  }
  const rows = (
    names.length > 0
      ? await ctx.sql`
          delete from reservations
          where holder = ${holder}
            and name = any(${ctx.sql.array(names, 'TEXT')})
          returning name
        `
      : await ctx.sql`
          delete from reservations where holder = ${holder} returning name
        `
  ) as { name: string }[];
  return ok({ holder, released: rows.map((row) => row.name).sort() }, ctx.id);
}
