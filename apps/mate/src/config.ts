export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  readonly token: string;
  readonly guildId: string;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly allowedChannelIds: ReadonlySet<string>;
  readonly quietMs: number;
  readonly maxTurnsPerThread: number;
  readonly maxTurnsPerDay: number;
  readonly maxConcurrent: number;
  readonly port: number;
  /** Where gateway session info is persisted for a resume, or `null` for memory only. */
  readonly sessionFile: string | null;
  readonly sandboxes: SandboxesChoice;
  /** The second surface, or `null` when mate answers on Discord alone. */
  readonly slack: SlackConfig | null;
}

export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string;
  readonly teamId: string;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly allowedChannelIds: ReadonlySet<string>;
}

/** What answers a thread: the in-process stub, or real Sandboxes on the cluster. */
export type SandboxesChoice =
  | { readonly mode: 'stub' }
  | { readonly mode: 'kube'; readonly sandbox: SandboxConfig };

export interface SandboxConfig {
  /** The harness image every sandbox runs; CD rewrites its digest on mate's Deployment. */
  readonly image: string;
  readonly runtimeClass: string;
  /** Where sandboxes are minted, or `null` for the namespace mate runs in. */
  readonly namespace: string | null;
  /** The Secret holding the provider key as `OPENCODE_API_KEY`. */
  readonly secret: string;
  readonly checkoutRepo: string;
  readonly checkoutRef: string;
  readonly model: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

function ids(env: Env, key: string): ReadonlySet<string> {
  const set = new Set(
    required(env, key)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const id of set) {
    if (!/^\d{15,22}$/.test(id)) {
      throw new ConfigError(`${key} holds a non-snowflake entry: ${id}`);
    }
  }
  if (set.size === 0) throw new ConfigError(`${key} is empty`);
  return set;
}

/** Slack ids are uppercase: `U…` a user, `C…` a channel, `T…` a workspace. */
const SLACK_ID = /^[A-Z][A-Z0-9]{1,20}$/;

function slackIds(env: Env, key: string): ReadonlySet<string> {
  const set = new Set(
    required(env, key)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const id of set) {
    if (!SLACK_ID.test(id)) {
      throw new ConfigError(`${key} holds a non-Slack id: ${id}`);
    }
  }
  if (set.size === 0) throw new ConfigError(`${key} is empty`);
  return set;
}

function integer(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${key} must be a positive integer, got ${raw}`);
  }
  return value;
}

function text(env: Env, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

export function readSandboxConfig(env: Env): SandboxConfig {
  return {
    image: required(env, 'MATE_SANDBOX_IMAGE'),
    runtimeClass: text(env, 'MATE_SANDBOX_RUNTIME_CLASS', 'kata-clh'),
    namespace: env.MATE_SANDBOX_NAMESPACE?.trim() || null,
    secret: text(env, 'MATE_OPENCODE_SECRET', 'mate-opencode'),
    checkoutRepo: text(
      env,
      'MATE_CHECKOUT_REPO',
      'https://github.com/jonpulsifer/infra',
    ),
    checkoutRef: text(env, 'MATE_CHECKOUT_REF', 'main'),
    model: text(env, 'MATE_SANDBOX_MODEL', 'opencode-go/qwen3.8-flash'),
  };
}

function sandboxes(env: Env): SandboxesChoice {
  const mode = text(env, 'MATE_SANDBOXES', 'stub');
  if (mode === 'stub') return { mode };
  if (mode === 'kube') return { mode, sandbox: readSandboxConfig(env) };
  throw new ConfigError(`MATE_SANDBOXES must be stub or kube, got ${mode}`);
}

/**
 * Off unless both tokens are set, so the surface is opt-in: half a Slack
 * configuration is a mistake worth refusing rather than half a bot.
 */
function slack(env: Env): SlackConfig | null {
  const bot = env.MATE_SLACK_BOT_TOKEN?.trim();
  const app = env.MATE_SLACK_APP_TOKEN?.trim();
  if (!bot && !app) return null;
  return {
    botToken: required(env, 'MATE_SLACK_BOT_TOKEN'),
    appToken: required(env, 'MATE_SLACK_APP_TOKEN'),
    teamId: required(env, 'MATE_SLACK_TEAM_ID'),
    allowedUserIds: slackIds(env, 'MATE_SLACK_ALLOWED_USER_IDS'),
    allowedChannelIds: slackIds(env, 'MATE_SLACK_ALLOWED_CHANNEL_IDS'),
  };
}

export function readConfig(env: Env): Config {
  return {
    token: required(env, 'DISCORD_TOKEN'),
    guildId: required(env, 'MATE_GUILD_ID'),
    allowedUserIds: ids(env, 'MATE_ALLOWED_USER_IDS'),
    allowedChannelIds: ids(env, 'MATE_ALLOWED_CHANNEL_IDS'),
    quietMs: integer(env, 'MATE_QUIET_MINUTES', 15) * 60_000,
    maxTurnsPerThread: integer(env, 'MATE_MAX_TURNS_PER_THREAD', 30),
    maxTurnsPerDay: integer(env, 'MATE_MAX_TURNS_PER_DAY', 120),
    maxConcurrent: integer(env, 'MATE_MAX_CONCURRENT', 3),
    port: integer(env, 'MATE_PORT', 8080),
    sessionFile: env.MATE_SESSION_FILE?.trim() || null,
    sandboxes: sandboxes(env),
    slack: slack(env),
  };
}
