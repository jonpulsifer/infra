import { TTL_MS } from './sandboxes.ts';

/**
 * The longest turn a GitHub App credential can carry. GitHub's installation
 * tokens live sixty minutes; five of those are the margin the token cache
 * holds back so a turn never starts on a token that cannot outlast it.
 */
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

/** What answers a thread: the in-process stub, or real Sandboxes on the cluster. */
export type SandboxesChoice =
  | { readonly mode: 'stub' }
  | {
      readonly mode: 'kube';
      readonly sandbox: SandboxConfig;
      /**
       * Beside `sandbox` rather than inside it, and that placement is the
       * whole security property: `sandboxManifest` takes a `SandboxConfig`
       * and turns it into a pod spec, so anything reachable from there can
       * be spread into a pod by an edit that meant no harm. The App's key
       * is not reachable from there.
       */
      readonly githubApp: GithubAppConfig | null;
      /**
       * Where mate's own pod holds the SSH private key a sandbox logs into
       * hosts with, or `null` for no host access. Beside `githubApp` and for
       * the same reason: `sandboxManifest` never sees it, so no edit there
       * can put a private key into a pod spec.
       */
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
  /** How long one turn may run before the harness call is abandoned. */
  readonly turnTimeoutMs: number;
  /**
   * How many sandboxes are kept warm ahead of the threads that will ask for
   * one. Zero is the pool switched off, and that is what mate runs with
   * unless its Deployment says otherwise: a spare holds a whole sandbox's
   * memory while it waits, out of the same room on the node that
   * `MATE_MAX_CONCURRENT` is already spending.
   */
  readonly spares: number;
  /**
   * The 1Password Connect address and token a sandbox is handed, or `null`
   * when it is handed neither. This is no longer how the GitHub credential
   * arrives — mate mints that itself — so it is off unless somebody names a
   * Secret, and what it is for is whatever else the sandbox's own vault is
   * stocked with.
   */
  readonly vault: VaultConfig | null;
  /**
   * Whether the pod gets a git credential helper and somewhere for a token
   * to land. It follows the App being configured, because the helper reads a
   * file only mate writes: with no App nothing ever writes it, and a helper
   * pointing at a file that will never exist is worse than no helper at all.
   */
  readonly github: boolean;
  /**
   * The ServiceAccount a sandbox debugs the cluster as, or `null` for a
   * sandbox with no cluster access at all — which is the default and the
   * rollback. mate mints a bound token for it per turn; the account itself is
   * declared in `sandbox-rbac.yaml` and is not the one mate runs as.
   */
  readonly kubeServiceAccount: string | null;
}

/**
 * What a sandbox needs to read a secret at the moment it needs it: the
 * in-cluster 1Password Connect API and the Secret holding the token that
 * reaches it. The vault those claims name is the boundary — a sandbox runs
 * agent-authored commands with every permission auto-allowed, so whatever is
 * in that vault is readable by whatever the agent decides to run.
 */
export interface VaultConfig {
  readonly connectHost: string;
  /** The Secret holding the Connect token as `OP_CONNECT_TOKEN`. */
  readonly connectSecret: string;
}

/**
 * The GitHub App mate mints a sandbox's token from. mate holds the key and
 * the sandbox never does, which is the point: an installation token lives an
 * hour and names one repository, and the key that makes them lives on the
 * other side of a `pods/exec`.
 *
 * `keyFile` rather than the PEM itself, because a mounted file keeps the key
 * out of mate's own `/proc/self/environ` — where an env var would sit for
 * anything that can read the process to find.
 */
export interface GithubAppConfig {
  readonly appId: string;
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

/** `min` is 1 for every cap, and 0 for the one setting whose off position is a number. */
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

/**
 * Off unless a Secret is named. Nothing the sandbox needs depends on this any
 * more — the GitHub token arrives from mate — so it is switched on only where
 * somebody has stocked the sandbox's vault with something and wants the agent
 * able to read it.
 */
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

/**
 * Off unless an app id is set, which is the rollback: with it unset mate
 * mints nothing, a sandbox gets no credential helper and no token file, and
 * threads carry on answering questions they can answer without pushing.
 *
 * Neither a malformed id nor an unreadable key is a `ConfigError`, and that is
 * deliberate rather than lax. mate runs one replica under
 * `strategy: Recreate`, so refusing to boot over the credential for a side
 * feature takes both chat surfaces down with it — a typo in this one value
 * would be a chat outage. Every such failure is caught where the App is
 * opened, and says so through `mate_github_app_ready`, which an alert watches:
 * loud, and survivable.
 *
 * The checkout is the exception and stays fatal. It is not about the App —
 * mate cannot clone from a URL it cannot parse either, so a sandbox built on
 * one is useless whether or not it could push.
 */
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

/**
 * The owner and repository a checkout URL names. It is read from the checkout
 * rather than configured twice, so the App can only ever mint for the
 * repository the sandbox actually clones.
 */
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
  // TTL_MS is the furthest out mate ever sets `spec.shutdownTime`, so a cap
  // at or past it promises a turn a window no sandbox lives long enough to
  // give.
  if (turnTimeoutMs >= TTL_MS) {
    throw new ConfigError(
      `MATE_TURN_MINUTES must be under the sandbox TTL of ${TTL_MS / 60_000} minutes, got ${turnTimeoutMs / 60_000}`,
    );
  }
  // A GitHub App installation token lives an hour and is minted at the start
  // of a turn, so a turn allowed to run longer than one can outlive its own
  // credential and fail its push at the end, having done the work. The margin
  // is what the token cache already reserves.
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
