export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  /** mate's bridge endpoint, a ws(s) URL inside the namespace. */
  readonly mateUrl: string;
  readonly port: number;
  readonly heartbeatMs: number;
  readonly connectTimeoutMs: number;
  readonly joinTimeoutMs: number;
  /** Rejoins in one call before the bridge gives up and leaves. */
  readonly rejoinCap: number;
  /** Rebuilds of the owner's receive stream before the bridge leaves. */
  readonly resubscribeCap: number;
  /** How long a call outlives the link to mate before the bridge leaves. */
  readonly orphanMs: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

function integer(env: Env, key: string, fallback: number, min = 1): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(
      `${key} must be an integer of at least ${min}, got ${raw}`,
    );
  }
  return value;
}

function wsUrl(env: Env, key: string): string {
  const raw = required(env, key);
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {}
  if (!url || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) {
    throw new ConfigError(`${key} must be a ws(s) URL, got ${raw}`);
  }
  return raw;
}

export function readConfig(env: Env): Config {
  return {
    mateUrl: wsUrl(env, 'MATE_VOICE_MATE_URL'),
    port: integer(env, 'MATE_VOICE_PORT', 8080),
    heartbeatMs: integer(env, 'MATE_VOICE_HEARTBEAT_MS', 5_000, 100),
    connectTimeoutMs: integer(
      env,
      'MATE_VOICE_CONNECT_TIMEOUT_MS',
      10_000,
      100,
    ),
    joinTimeoutMs: integer(env, 'MATE_VOICE_JOIN_TIMEOUT_MS', 20_000, 1_000),
    rejoinCap: integer(env, 'MATE_VOICE_REJOIN_CAP', 3, 0),
    resubscribeCap: integer(env, 'MATE_VOICE_RESUBSCRIBE_CAP', 5, 0),
    orphanMs: integer(env, 'MATE_VOICE_ORPHAN_MS', 30_000, 1_000),
  };
}
