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
  /**
   * The private host claiming and site control answer on, or `null` when the
   * apex answers them itself. Outside the zone by construction: a label
   * inside it would shadow the site of that name.
   */
  readonly controlHost: string | null;
  /**
   * The tailnet host an identity header is believed on, or `null`.
   *
   * Outside the zone and never the control host, for the reason above and
   * because the two doors believe different things: the control host is
   * reach-is-identity and an agent's bearer, this one is a person the tailnet
   * vouched for. `null` reads the header nowhere, which is the kill switch.
   */
  readonly identityHost: string | null;
  /**
   * The header {@link identityHost} is read from — the tailnet proxy's, which
   * strips whatever the client sent before setting its own.
   */
  readonly identityHeader: string;
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
   * What opens `DELETE /api/sites`, the nuke — the operator's key, never a
   * site's and never a visitor's. Unset is not a disabled feature: the route
   * answers 404 like a path this server does not have, and the landing page's
   * control stays hidden.
   *
   * A key shorter than the contract's 32 bytes is refused the same way an
   * unset one is — `null`, a 404, one line on stderr — rather than trusted or
   * thrown on. Throwing would take a whole zone down over a hand-typed
   * 1Password field, and trusting it would leave a destructive, unmetered
   * route behind something guessable.
   */
  readonly adminKey: string | null;
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
  /** The ceiling `max_tokens` is clamped to, named or not, on `/api/ai`. */
  readonly aiMaxTokens: number;
  /**
   * The same ceiling for the authenticated build route.
   *
   * Two numbers because `/api/ai` is anonymous on every site in the zone and
   * the clamp is also the floor a silent answer is billed, while a route that
   * generates a whole document needs thousands of completion tokens. One
   * global is what makes raising the second raise the first. Unset is the
   * public ceiling, so a deployment that says nothing raises nothing.
   */
  readonly aiBuildMaxTokens: number;
  /**
   * The peers whose `cf-connecting-ip` is believed: the Gateway hop in front of
   * this pod. Empty means no peer is, so every address-keyed bucket falls back
   * to the socket address — which behind a proxy is one key for the whole zone.
   * The chart sets it; a deployment that does not is rate limiting itself.
   */
  readonly trustedProxies: readonly string[];
  /**
   * The peers whose identity header and `x-forwarded-for` are believed: the
   * tailnet proxy, and nothing else.
   *
   * Separate from {@link trustedProxies} and empty by default because that one
   * is the whole pod CIDR in the chart — reusing it would let any pod in the
   * cluster assert it is anybody.
   */
  readonly tailnetProxies: readonly string[];
  readonly port: number;
}

type Env = Record<string, string | undefined>;

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

/** A comma-separated list of peers, blanks dropped. */
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
  const admin = env.KTHX_ADMIN_KEY?.trim() ?? '';
  if (admin !== '' && byteLength(admin) < KEY_BYTES) {
    console.error(
      `KTHX_ADMIN_KEY is shorter than ${KEY_BYTES} bytes; the nuke stays closed`,
    );
  }
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
    // One host cannot be two doors: the control host believes reach and the
    // identity host believes a header, and a host that was both would hand
    // every agent on the lab network whatever login it cared to assert.
    if (identityHost === controlHost) {
      throw new ConfigError('KTHX_IDENTITY_HOST must not be KTHX_CONTROL_HOST');
    }
    // An identity host with nobody to believe is the worst of both: it renders
    // a reachable name, answers every caller on it as anonymous, and lets them
    // claim sites that are tied to no account at all. Refusing here is the same
    // class of failure as the two guards above — a deployment that is wrong
    // rather than a request that is.
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
  // A default outside its own allow-list is refused here rather than per
  // request: `/api/ai` writes the default into a body that names no model and
  // only then checks it, so one typo in a chart value answers every keyless
  // call 400 INVALID_MODEL, as though the page had asked for something it may
  // not have.
  if (aiModels.length > 0 && !aiModels.includes(aiModel)) {
    throw new ConfigError(
      `KTHX_AI_MODEL ${aiModel} is not one of KTHX_AI_MODELS`,
    );
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
    adminKey: byteLength(admin) >= KEY_BYTES ? admin : null,
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
    trustedProxies: peers(env.KTHX_TRUSTED_PROXIES),
    tailnetProxies,
    port: Number(env.PORT?.trim() || 8080),
  };
}
