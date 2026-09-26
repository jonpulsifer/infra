export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  readonly elevenlabsApiKey: string;
  /** The agent to look up at boot, when no id overrides it. */
  readonly agentName: string;
  /** From SWITCHBOARD_AGENT_ID: skips the lookup by name. */
  readonly agentId?: string;
  readonly phoneNumberId: string;
  /** The only number switchboard ever dials. No request can override it. */
  readonly toNumber: string;
  readonly ringToken: string;
  readonly alertToken: string;
  readonly ringDailyCap: number;
  readonly alertDailyCap: number;
  readonly cooldownMs: number;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly quietTz: string;
  readonly port: number;
}

/** A Config once boot has settled the agent id. */
export type ResolvedConfig = Config & { readonly agentId: string };

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

function optional(env: Env, key: string): string | undefined {
  return env[key]?.trim() || undefined;
}

function integer(env: Env, key: string, fallback: number, min: number): number {
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

// A leading +, then 8-15 digits total: loose E.164, tight enough to catch a
// local-format or punctuated number pasted in by mistake.
const E164 = /^\+[1-9]\d{7,14}$/;

function readToNumber(env: Env): string {
  const value = required(env, 'SWITCHBOARD_TO_NUMBER');
  if (!E164.test(value)) {
    throw new ConfigError(
      'SWITCHBOARD_TO_NUMBER must be E.164: a + then 8-15 digits',
    );
  }
  return value;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clockTime(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!HHMM.test(value)) {
    throw new ConfigError(`${key} must be HH:MM, got ${value}`);
  }
  return value;
}

function timezone(env: Env, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    throw new ConfigError(`${key} names an unknown time zone: ${value}`);
  }
  return value;
}

export function readConfig(env: Env): Config {
  return {
    elevenlabsApiKey: required(env, 'ELEVENLABS_API_KEY'),
    agentName: optional(env, 'SWITCHBOARD_AGENT_NAME') ?? 'pbx-switchboard',
    agentId: optional(env, 'SWITCHBOARD_AGENT_ID'),
    phoneNumberId: required(env, 'SWITCHBOARD_PHONE_NUMBER_ID'),
    toNumber: readToNumber(env),
    ringToken: required(env, 'SWITCHBOARD_RING_TOKEN'),
    alertToken: required(env, 'SWITCHBOARD_ALERT_TOKEN'),
    ringDailyCap: integer(env, 'SWITCHBOARD_RING_DAILY_CAP', 3, 1),
    alertDailyCap: integer(env, 'SWITCHBOARD_ALERT_DAILY_CAP', 3, 1),
    cooldownMs: integer(env, 'SWITCHBOARD_COOLDOWN_MINUTES', 10, 0) * 60_000,
    quietStart: clockTime(env, 'SWITCHBOARD_QUIET_START', '23:00'),
    quietEnd: clockTime(env, 'SWITCHBOARD_QUIET_END', '08:00'),
    quietTz: timezone(env, 'SWITCHBOARD_QUIET_TZ', 'America/Halifax'),
    port: integer(env, 'SWITCHBOARD_PORT', 8080, 1),
  };
}
