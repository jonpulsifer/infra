/**
 * Process configuration, read once at boot. A missing or short HMAC key fails
 * boot. The cookie key and the Postgres password key are separate, so rotating
 * one leaves the other's output unchanged.
 */

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  /** The zone sites live under. `Host === zone` is the apex. */
  readonly zone: string;
  /**
   * The private host for claims and site control, or `null` for the apex. It
   * must be outside the zone, where a label would shadow the site of that name.
   */
  readonly controlHost: string | null;
  /**
   * The tailnet host where the identity header is read; `null` reads it
   * nowhere. It must be outside the zone and differ from the control host.
   */
  readonly identityHost: string | null;
  /** The tailnet proxy replaces any client-sent copy of this header. */
  readonly identityHeader: string;
  /** `null` uses the local-disk depot. */
  readonly bucket: string | null;
  /** Where release directories are unpacked. */
  readonly sitesDir: string;
  readonly databaseUrl: string;
  /** Signs the visitor cookie. */
  readonly meKey: string;
  /**
   * Verifies only, so after a rotation each cookie is re-signed on its next
   * call and keeps its id.
   */
  readonly mePreviousKey: string | null;
  /** Derives per-site Postgres passwords. */
  readonly pgKey: string;
  /**
   * Tailnet logins that may `DELETE /api/sites`. Empty, the default, answers
   * 404 as though the route did not exist.
   */
  readonly adminLogins: readonly string[];
  /** Names the template database `template_<prefix>` and role `<prefix>_site`. */
  // ponytail: a field only so test runs sharing one Postgres do not collide.
  readonly pgPrefix: string;
  /** Measured by `pg_database_size`. */
  readonly maxDbBytes: number;
  /** Per site. */
  readonly maxCollections: number;
  /** An OpenAI-compatible base URL. */
  readonly aiUrl: string;
  /** `null` makes `/api/ai` answer 502 `AI_UPSTREAM` without calling out. */
  readonly aiKey: string | null;
  /** For a request that names no model. */
  readonly aiModel: string;
  /** The models a site may name. Empty allows every upstream model. */
  readonly aiModels: readonly string[];
  /** `/api/ai` clamps `max_tokens` to this, and applies it when none is sent. */
  readonly aiMaxTokens: number;
  /**
   * The build route writes full pages, so it gets its own ceiling; `/api/ai`
   * is anonymous. Unset uses {@link aiMaxTokens}.
   */
  readonly aiBuildMaxTokens: number;
  /** The build route's model; {@link aiModel} is chosen for short answers. */
  readonly aiBuildModel: string;
  /** Tried when the build model writes no content. `null` means no fallback. */
  readonly aiBuildFallbackModel: string | null;
  /**
   * Peers whose `cf-connecting-ip` is trusted. Empty keys every bucket by the
   * socket address, which behind a proxy puts every caller on one key.
   */
  readonly trustedProxies: readonly string[];
  /**
   * Peers whose identity header and `x-forwarded-for` are trusted. Separate
   * from {@link trustedProxies}, which can span the pod CIDR.
   */
  readonly tailnetProxies: readonly string[];
  readonly port: number;
}

type Env = Record<string, string | undefined>;

/** The minimum HMAC key length. */
const KEY_BYTES = 32;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

// A `NaN` ceiling serialises as `null` and breaks token billing, so a typo
// falls back to the default.
function positive(raw: string | undefined, fallback: number): number {
  const asked = Number(raw?.trim() ?? '');
  return Number.isFinite(asked) && asked > 0 ? asked : fallback;
}

function peers(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

const byteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;

function longEnough(name: string, value: string): string {
  if (byteLength(value) < KEY_BYTES) {
    throw new ConfigError(`${name} is shorter than ${KEY_BYTES} bytes`);
  }
  return value;
}

export function readConfig(env: Env = Bun.env): Config {
  const previous = env.KTHX_ME_KEY_PREVIOUS?.trim();
  const zone = env.KTHX_ZONE?.trim().toLowerCase() || 'kthx.dev';
  const controlHost = env.KTHX_CONTROL_HOST?.trim().toLowerCase() || null;
  if (
    controlHost !== null &&
    (controlHost === zone || controlHost.endsWith(`.${zone}`))
  ) {
    throw new ConfigError(`KTHX_CONTROL_HOST must be outside ${zone}`);
  }
  const identityHost = env.KTHX_IDENTITY_HOST?.trim().toLowerCase() || null;
  const tailnetProxies = peers(env.KTHX_TAILNET_PROXIES);
  if (identityHost !== null) {
    if (identityHost === zone || identityHost.endsWith(`.${zone}`)) {
      throw new ConfigError(`KTHX_IDENTITY_HOST must be outside ${zone}`);
    }
    // The control host trusts reach and the identity host trusts a header, so
    // one host serving both would let any client assert any login.
    if (identityHost === controlHost) {
      throw new ConfigError('KTHX_IDENTITY_HOST must not be KTHX_CONTROL_HOST');
    }
    // With no trusted proxy, every caller there is anonymous and could claim
    // sites tied to no login.
    if (tailnetProxies.length === 0) {
      throw new ConfigError(
        'KTHX_IDENTITY_HOST needs KTHX_TAILNET_PROXIES: the hop whose identity header is believed',
      );
    }
  }
  const aiModel = env.KTHX_AI_MODEL?.trim() || 'minimax-m3';
  const aiModels = (env.KTHX_AI_MODELS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  // `/api/ai` fills in the default before checking the allow-list, so a bad
  // default would fail every call that names no model.
  if (aiModels.length > 0 && !aiModels.includes(aiModel)) {
    throw new ConfigError(
      `KTHX_AI_MODEL ${aiModel} is not one of KTHX_AI_MODELS`,
    );
  }
  const aiBuildModel = env.KTHX_AI_BUILD_MODEL?.trim() || aiModel;
  const aiBuildFallbackModel = env.KTHX_AI_BUILD_FALLBACK_MODEL?.trim() || null;
  // Likewise, a build model outside the allow-list would fail every build.
  for (const named of [aiBuildModel, aiBuildFallbackModel]) {
    if (named === null || aiModels.length === 0 || aiModels.includes(named)) {
      continue;
    }
    throw new ConfigError(`build model ${named} is not one of KTHX_AI_MODELS`);
  }
  const aiMaxTokens = positive(env.KTHX_AI_MAX_TOKENS, 4096);
  return {
    zone,
    controlHost,
    identityHost,
    identityHeader:
      env.KTHX_IDENTITY_HEADER?.trim().toLowerCase() || 'tailscale-user-login',
    bucket: env.KTHX_BUCKET?.trim() || null,
    sitesDir: env.KTHX_SITES_DIR?.trim() || '/sites',
    databaseUrl: required(env, 'DATABASE_URL'),
    meKey: longEnough('KTHX_ME_KEY', required(env, 'KTHX_ME_KEY')),
    mePreviousKey:
      previous === undefined
        ? null
        : longEnough('KTHX_ME_KEY_PREVIOUS', previous),
    pgKey: longEnough('KTHX_PG_KEY', required(env, 'KTHX_PG_KEY')),
    adminLogins: (env.KTHX_ADMIN_LOGINS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ''),
    pgPrefix: 'kthx',
    maxDbBytes: 256 * 1024 * 1024,
    maxCollections: 256,
    aiUrl: (env.KTHX_AI_URL?.trim() || 'https://opencode.ai/zen/v1').replace(
      /\/+$/,
      '',
    ),
    aiKey: env.KTHX_AI_KEY?.trim() || null,
    aiModel,
    aiModels,
    aiMaxTokens,
    aiBuildMaxTokens: positive(env.KTHX_AI_BUILD_MAX_TOKENS, aiMaxTokens),
    aiBuildModel,
    aiBuildFallbackModel,
    trustedProxies: peers(env.KTHX_TRUSTED_PROXIES),
    tailnetProxies,
    port: Number(env.PORT?.trim() || 8080),
  };
}
