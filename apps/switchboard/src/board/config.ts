import { ConfigError } from '../config.ts';

export interface BoardConfig {
  /** Asterisk's HTTP server: scheme, host and port, with no path. */
  readonly ariUrl: string;
  readonly ariUser: string;
  readonly ariPassword: string;
  /** The folly pjsip.conf template, which names each line's trunk. */
  readonly pjsipConf: string;
  readonly recentLimit: number;
  readonly port: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

function integer(
  env: Env,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

// The credential travels in an Authorization header, never in the URL, so a
// URL that carries one, or a path or query that could, is refused. The
// message never repeats the value.
function readAriUrl(env: Env): string {
  const raw = required(env, 'SWITCHBOARD_ARI_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('SWITCHBOARD_ARI_URL is not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('SWITCHBOARD_ARI_URL must be http or https');
  }
  if (url.username || url.password) {
    throw new ConfigError('SWITCHBOARD_ARI_URL must not carry a credential');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigError('SWITCHBOARD_ARI_URL must have no path or query');
  }
  return url.origin;
}

export function readBoardConfig(env: Env): BoardConfig {
  return {
    ariUrl: readAriUrl(env),
    ariUser: required(env, 'SWITCHBOARD_ARI_USER'),
    ariPassword: required(env, 'SWITCHBOARD_ARI_PASSWORD'),
    pjsipConf:
      env.SWITCHBOARD_PJSIP_CONF?.trim() || '/etc/switchboard/pjsip.conf',
    recentLimit: integer(env, 'SWITCHBOARD_RECENT', 25, 1, 200),
    port: integer(env, 'SWITCHBOARD_PORT', 8080, 1, 65535),
  };
}
