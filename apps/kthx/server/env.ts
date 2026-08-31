/**
 * Everything the process is told, read once and refused early.
 *
 * A missing key is a boot failure rather than a 500 on the first request that
 * needs it: this is a public anonymous-write zone, and the two HMAC keys are
 * what keep a visitor cookie and a site's database password unforgeable. A
 * process that started without them looks healthy right up until it mints
 * something signed with `undefined`.
 *
 * Two keys rather than one because they rotate for different reasons: turning
 * over cookie signatures must not change every site's derived database
 * password, which is what a single key would make it do.
 */

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  /** The zone sites live under. `Host === zone` is the apex. */
  readonly zone: string;
  /** The depot bucket, or `null` for the local-disk fallback. */
  readonly bucket: string | null;
  /** Where release directories are unpacked. */
  readonly sitesDir: string;
  readonly databaseUrl: string;
  /** Signs the visitor cookie (used from ticket 03 on). */
  readonly meKey: string;
  /** Verification only, so a rotation re-mints lazily instead of logging out. */
  readonly mePreviousKey: string | null;
  /** Derives per-site Postgres passwords. */
  readonly pgKey: string;
  /**
   * What the template database and the group role are called: `template_kthx`
   * and `kthx_site`.
   *
   * ponytail: a knob only because both are cluster-wide names, so two test
   * runs against one Postgres would otherwise fight over the template — a
   * clone fails while any session is on it. Production never sets it.
   */
  readonly pgPrefix: string;
  /** The site database ceiling, measured by `pg_database_size`. */
  readonly maxDbBytes: number;
  /** Collections one site may hold. */
  readonly maxCollections: number;
  /** The OpenAI-compatible upstream `/api/ai` forwards to. */
  readonly aiUrl: string;
  /**
   * The upstream's key, or `null` when this deployment has none.
   *
   * Null is not a disabled route: `/api/ai` answers 502 `AI_UPSTREAM`, which is
   * what an upstream with no key would have answered anyway, one round trip
   * later and on the operator's bill.
   */
  readonly aiKey: string | null;
  /** What a request that names no model gets. */
  readonly aiModel: string;
  /** The models a site may name. Empty is every model the upstream has. */
  readonly aiModels: readonly string[];
  /** The ceiling `max_tokens` is clamped to, named or not. */
  readonly aiMaxTokens: number;
  /**
   * The `aud` values an ID token may carry.
   *
   * The default is gcloud's own OAuth client id, which is what
   * `gcloud auth print-identity-token` puts in `aud` when it is asked for no
   * audience — read out of this machine's gcloud credential store, where it is
   * the `client_id` of the stored user credential.
   */
  readonly oidcAudiences: readonly string[];
  /**
   * Where the RSA public keys come from: Google, and no environment says
   * otherwise. A test hands this field its own JWKS directly; an operator
   * cannot point the verifier at keys nobody chose.
   */
  readonly jwksUrl: string;
  /**
   * The header a trusted hop uses to say which address the caller is, or
   * `null`.
   *
   * The IAP / pass-through seam, off by default: with nothing named here the
   * only identity this server believes is one it verified itself. Naming one
   * asks for IAP's pair — the hop must also send the subject in
   * `x-goog-authenticated-user-id`, because `owner_sub` is what ownership
   * compares and an asserted address alone would open nothing.
   */
  readonly trustedIdentityHeader: string | null;
  /**
   * The peers whose `cf-connecting-ip` is believed: the Gateway hop in front of
   * this pod. Empty means no peer is, so every address-keyed bucket falls back
   * to the socket address — which behind a proxy is one key for the whole zone.
   * The chart sets it; a deployment that does not is rate limiting itself.
   */
  readonly trustedProxies: readonly string[];
  readonly port: number;
}

type Env = Record<string, string | undefined>;

/** gcloud's installed-app client id: the `aud` of the token it prints. */
const GCLOUD_CLIENT_ID = '32555940559.apps.googleusercontent.com';

/** Google's published RS256 keys. */
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

function list(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** ≥ 32 bytes, per the contract — a shorter HMAC key is a weaker one. */
const KEY_BYTES = 32;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

/**
 * A positive number, or the default.
 *
 * `Number('four')` is `NaN`, and a `NaN` ceiling is no ceiling: it serialises
 * as `null` on the wire and turns the token billing into a statement Postgres
 * refuses. A typo in a chart value must not quietly remove a spend control.
 */
function positive(raw: string | undefined, fallback: number): number {
  const asked = Number(raw?.trim() ?? '');
  return Number.isFinite(asked) && asked > 0 ? asked : fallback;
}

function longEnough(name: string, value: string): string {
  if (new TextEncoder().encode(value).byteLength < KEY_BYTES) {
    throw new ConfigError(`${name} is shorter than ${KEY_BYTES} bytes`);
  }
  return value;
}

export function readConfig(env: Env = Bun.env): Config {
  const previous = env.KTHX_ME_KEY_PREVIOUS?.trim();
  const audiences = list(env.KTHX_OIDC_AUDIENCES);
  return {
    zone: env.KTHX_ZONE?.trim().toLowerCase() || 'kthx.dev',
    bucket: env.KTHX_BUCKET?.trim() || null,
    sitesDir: env.KTHX_SITES_DIR?.trim() || '/sites',
    databaseUrl: required(env, 'DATABASE_URL'),
    meKey: longEnough('KTHX_ME_KEY', required(env, 'KTHX_ME_KEY')),
    mePreviousKey:
      previous === undefined
        ? null
        : longEnough('KTHX_ME_KEY_PREVIOUS', previous),
    pgKey: longEnough('KTHX_PG_KEY', required(env, 'KTHX_PG_KEY')),
    pgPrefix: 'kthx',
    maxDbBytes: 256 * 1024 * 1024,
    maxCollections: 256,
    aiUrl: (env.KTHX_AI_URL?.trim() || 'https://opencode.ai/zen/v1').replace(
      /\/+$/,
      '',
    ),
    aiKey: env.KTHX_AI_KEY?.trim() || null,
    aiModel: env.KTHX_AI_MODEL?.trim() || 'minimax-m3',
    aiModels: list(env.KTHX_AI_MODELS),
    aiMaxTokens: positive(env.KTHX_AI_MAX_TOKENS, 4096),
    oidcAudiences: audiences.length === 0 ? [GCLOUD_CLIENT_ID] : audiences,
    jwksUrl: GOOGLE_JWKS,
    trustedIdentityHeader:
      env.KTHX_TRUSTED_IDENTITY_HEADER?.trim().toLowerCase() || null,
    trustedProxies: list(env.KTHX_TRUSTED_PROXIES),
    port: Number(env.PORT?.trim() || 8080),
  };
}
