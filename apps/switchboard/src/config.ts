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
  /** From SWITCHBOARD_MISSION_TOKEN: absent means missions are off. */
  readonly missionToken?: string;
  readonly missionAgentName: string;
  /** One file per mission target: the name is the key, the content E.164. */
  readonly targetsDir: string;
  readonly missionDailyCap: number;
  readonly quietStart: string;
  readonly quietEnd: string;
  readonly quietTz: string;
  readonly port: number;
  /** From SWITCHBOARD_PERSONA_TOKEN: absent means the persona routes are off. */
  readonly personaToken?: string;
  /** The agents whose persona the routes edit, by name. */
  readonly personaAgentNames: readonly string[];
  /** Where the desired agent files live in the repo, for the snapshot. */
  readonly personaDir: string;
  /** Without an App id and key file, a persona edit is live only, no snapshot. */
  readonly githubAppId?: string;
  readonly githubAppKeyFile?: string;
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubBase: string;
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
export const E164 = /^\+[1-9]\d{7,14}$/;

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
    missionToken: optional(env, 'SWITCHBOARD_MISSION_TOKEN'),
    missionAgentName:
      optional(env, 'SWITCHBOARD_MISSION_AGENT_NAME') ?? 'pbx-mission',
    targetsDir: optional(env, 'SWITCHBOARD_TARGETS_DIR') ?? '/targets',
    missionDailyCap: integer(env, 'SWITCHBOARD_MISSION_DAILY_CAP', 5, 1),
    quietStart: clockTime(env, 'SWITCHBOARD_QUIET_START', '23:00'),
    quietEnd: clockTime(env, 'SWITCHBOARD_QUIET_END', '08:00'),
    quietTz: timezone(env, 'SWITCHBOARD_QUIET_TZ', 'America/Halifax'),
    port: integer(env, 'SWITCHBOARD_PORT', 8080, 1),
    personaToken: optional(env, 'SWITCHBOARD_PERSONA_TOKEN'),
    personaAgentNames: names(
      env,
      'SWITCHBOARD_PERSONA_AGENTS',
      'pbx-troll,pbx-switchboard,pbx-mission',
    ),
    personaDir:
      optional(env, 'SWITCHBOARD_PERSONA_DIR') ??
      'clusters/offsite/apps/elevenlabs/desired/agents',
    githubAppId: optional(env, 'SWITCHBOARD_GITHUB_APP_ID'),
    githubAppKeyFile: optional(env, 'SWITCHBOARD_GITHUB_APP_KEY_FILE'),
    ...repository(env, 'SWITCHBOARD_GITHUB_REPO', 'jonpulsifer/infra'),
    githubBase: optional(env, 'SWITCHBOARD_GITHUB_BASE') ?? 'main',
  };
}

const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function names(env: Env, key: string, fallback: string): string[] {
  const list = (env[key]?.trim() || fallback)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of list) {
    if (!AGENT_NAME.test(name)) {
      throw new ConfigError(`${key} holds a bad agent name: ${name}`);
    }
  }
  return [...new Set(list)];
}

const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

function repository(env: Env, key: string, fallback: string) {
  const value = env[key]?.trim() || fallback;
  const match = REPOSITORY.exec(value);
  if (!match) throw new ConfigError(`${key} must be owner/repo, got ${value}`);
  return { githubOwner: match[1] as string, githubRepo: match[2] as string };
}
