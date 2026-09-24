import { TTL_MS } from './sandboxes.ts';

// Installation tokens live 60 minutes, less the 5 the token cache reserves
// for the final push.
const APP_TURN_CAP_MS = 55 * 60_000;

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

export type SandboxesChoice =
  | { readonly mode: 'stub' }
  | {
      readonly mode: 'kube';
      readonly sandbox: SandboxConfig;
      // Outside `sandbox`: `sandboxManifest` turns a `SandboxConfig` into a pod
      // spec, so no secret may be reachable from it.
      readonly githubApp: GithubAppConfig | null;
      /** `null` for no host access. Outside `sandbox`, as `githubApp` is. */
      readonly sshKeyFile: string | null;
    };

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
  readonly turnTimeoutMs: number;
  /** 0, the default, is off: an idle spare holds a full sandbox's memory. */
  readonly spares: number;
  /** `null`, the default, gives the sandbox no 1Password Connect access. */
  readonly vault: VaultConfig | null;
  /** Follows the App: without one, nothing writes the file the helper reads. */
  readonly github: boolean;
  /**
   * `null`, the default, gives no cluster access. A separate account from
   * mate's, in `sandbox-rbac.yaml`.
   */
  readonly kubeServiceAccount: string | null;
}

// The vault is the boundary: the agent's commands are auto-allowed, so it can
// read anything the vault holds.
export interface VaultConfig {
  readonly connectHost: string;
  /** The Secret holding the Connect token as `OP_CONNECT_TOKEN`. */
  readonly connectSecret: string;
}

export interface GithubAppConfig {
  readonly appId: string;
  // A file, since an env var would expose the key in `/proc/self/environ`.
  readonly keyFile: string;
  /** Parsed from the checkout, so the App is never pointed at a repo nobody clones. */
  readonly owner: string;
  readonly repo: string;
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

// `min` is 0 only for a setting where 0 means off.
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

function text(env: Env, key: string, fallback: string): string {
  return env[key]?.trim() || fallback;
}

function vault(env: Env): VaultConfig | null {
  const connectSecret = env.MATE_CONNECT_SECRET?.trim();
  if (!connectSecret) return null;
  return {
    connectHost: text(
      env,
      'MATE_CONNECT_HOST',
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    ),
    connectSecret,
  };
}

// A bad App id or key is not a `ConfigError`, since the one replica failing to
// boot would take both chat surfaces down. A non-GitHub checkout URL is one.
function githubApp(env: Env, checkoutRepo: string): GithubAppConfig | null {
  const appId = env.MATE_GITHUB_APP_ID?.trim();
  if (!appId) return null;
  const slug = repoSlug(checkoutRepo);
  if (!slug) {
    throw new ConfigError(
      `MATE_CHECKOUT_REPO must name a GitHub owner and repository to mint App tokens for, got ${checkoutRepo}`,
    );
  }
  return {
    appId,
    keyFile: text(
      env,
      'MATE_GITHUB_APP_KEY_FILE',
      '/var/run/mate/github-app/private-key',
    ),
    ...slug,
  };
}

export function repoSlug(url: string): { owner: string; repo: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
    url.trim(),
  );
  const owner = match?.[1];
  const repo = match?.[2];
  return owner && repo ? { owner, repo } : null;
}

export function readSandboxConfig(env: Env): SandboxConfig {
  const turnTimeoutMs = integer(env, 'MATE_TURN_MINUTES', 45) * 60_000;
  // No sandbox lives past TTL_MS, so a longer turn could never finish.
  if (turnTimeoutMs >= TTL_MS) {
    throw new ConfigError(
      `MATE_TURN_MINUTES must be under the sandbox TTL of ${TTL_MS / 60_000} minutes, got ${turnTimeoutMs / 60_000}`,
    );
  }
  // A longer turn could outlive its token and fail the final push.
  if (env.MATE_GITHUB_APP_ID?.trim() && turnTimeoutMs >= APP_TURN_CAP_MS) {
    throw new ConfigError(
      `MATE_TURN_MINUTES must be under ${APP_TURN_CAP_MS / 60_000} minutes while a GitHub App is configured, got ${turnTimeoutMs / 60_000}`,
    );
  }
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
    turnTimeoutMs,
    spares: integer(env, 'MATE_SPARES', 0, 0),
    vault: vault(env),
    github: Boolean(env.MATE_GITHUB_APP_ID?.trim()),
    kubeServiceAccount: env.MATE_SANDBOX_KUBE_SA?.trim() || null,
  };
}

function sandboxes(env: Env): SandboxesChoice {
  const mode = text(env, 'MATE_SANDBOXES', 'stub');
  if (mode === 'stub') return { mode };
  if (mode === 'kube') {
    const sandbox = readSandboxConfig(env);
    return {
      mode,
      sandbox,
      githubApp: githubApp(env, sandbox.checkoutRepo),
      sshKeyFile: env.MATE_SSH_KEY_FILE?.trim() || null,
    };
  }
  throw new ConfigError(`MATE_SANDBOXES must be stub or kube, got ${mode}`);
}

// Opt-in; setting only one of the two tokens is a `ConfigError`.
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
    quietMs: integer(env, 'MATE_QUIET_MINUTES', 30) * 60_000,
    maxTurnsPerThread: integer(env, 'MATE_MAX_TURNS_PER_THREAD', 30),
    maxTurnsPerDay: integer(env, 'MATE_MAX_TURNS_PER_DAY', 120),
    maxConcurrent: integer(env, 'MATE_MAX_CONCURRENT', 3),
    port: integer(env, 'MATE_PORT', 8080),
    sessionFile: env.MATE_SESSION_FILE?.trim() || null,
    sandboxes: sandboxes(env),
    slack: slack(env),
  };
}
