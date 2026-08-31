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
  /** Derives per-site Postgres passwords (used from ticket 03 on). */
  readonly pgKey: string;
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

function longEnough(name: string, value: string): string {
  if (new TextEncoder().encode(value).byteLength < KEY_BYTES) {
    throw new ConfigError(`${name} is shorter than ${KEY_BYTES} bytes`);
  }
  return value;
}

export function readConfig(env: Env = Bun.env): Config {
  const previous = env.KTHX_ME_KEY_PREVIOUS?.trim();
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
    port: Number(env.PORT?.trim() || 8080),
  };
}
