import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { TTL_MS } from './lease.ts';

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
  /** Running turns, across every thread and surface. */
  readonly maxConcurrent: number;
  /** Sandboxes leased at once; a turn's first tool call waits for one. */
  readonly maxSandboxes: number;
  readonly port: number;
  /** Where gateway session info is persisted for a resume, or `null` for memory only. */
  readonly sessionFile: string | null;
  readonly sandboxes: SandboxesChoice;
  /** The second surface, or `null` when mate answers on Discord alone. */
  readonly slack: SlackConfig | null;
  /** A daily 18:00 America/Halifax report, disabled without a channel. */
  readonly custodianChannel: string | null;
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
      readonly brain: BrainConfig;
      // Outside `sandbox`: `sandboxManifest` turns a `SandboxConfig` into a pod
      // spec, so no secret may be reachable from it.
      readonly githubApp: GithubAppConfig | null;
      /** `null` for no host access. Outside `sandbox`, as `githubApp` is. */
      readonly sshKeyFile: string | null;
    };

/** The agent loop in mate's own process: its model, its store and its kthx tools. */
export interface BrainConfig {
  /** `provider/model`. */
  readonly model: string;
  readonly thinking: ThinkingLevel;
  /** `provider/model` that answers when ChatGPT cannot; `null` for `none`. */
  readonly fallbackModel: string | null;
  /** `null` takes the fallback's supported level nearest `thinking`. */
  readonly fallbackThinking: ThinkingLevel | null;
  /** Read on every request; never copied into the environment. */
  readonly modelKeyFile: string;
  /** `null` leaves the store down, which is not a reason to refuse to boot. */
  readonly databaseUrl: string | null;
  readonly databaseCaFile: string;
  /**
   * The MCP servers whose tools the brain loads. kthx needs both halves or is
   * absent: its token is a secret, so it stays out of `SandboxConfig`.
   */
  readonly mcpServers: readonly McpServerConfig[];
  /** Holds AGENTS.md and the skills; `null` is the repo root beside the source. */
  readonly profileRoot: string | null;
  /** 0 keeps every session. */
  readonly sessionRetentionDays: number;
}

export interface McpServerConfig {
  /** Also the tool prefix, as `<name>_`. */
  readonly name: 'kthx' | 'weather';
  readonly url: string;
  /** `null` for a server that takes none. */
  readonly token: string | null;
}

export interface SandboxConfig {
  /** The harness image every sandbox runs; CD rewrites its digest on mate's Deployment. */
  readonly image: string;
  readonly runtimeClass: string;
  /** Where sandboxes are minted, or `null` for the namespace mate runs in. */
  readonly namespace: string | null;
  readonly checkoutRepo: string;
  readonly checkoutRef: string;
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
  /**
   * `null`, the default, gives read-only profiles no cluster access. A
   * separate account from the admin, in `sandbox-rbac.yaml`.
   */
  readonly kubeReaderServiceAccount: string | null;
  /** The kubeconfig context for the cluster mate runs on. */
  readonly kubeContext: string;
  /**
   * Other clusters that admit the same token, by their directory under
   * `clusters/`; the sandbox's checkout says where each is and what CA it has.
   */
  readonly kubePeers: readonly string[];
  readonly kthx: KthxConfig;
  /** `null`, the default, gives the sandbox no way to ring the owner. */
  readonly switchboard: SwitchboardConfig | null;
}

/**
 * The `kthx` CLI in the sandbox, off on a `null` origin: it runs against the
 * private claiming host and keeps its site tokens in a Secret across
 * sandboxes. Names only, never a token, so `sandboxManifest` may read it.
 */
export interface KthxConfig {
  readonly origin: string | null;
  /** The Secret whose `sites.json` is the CLI's token file, kept between sandboxes. */
  readonly sitesSecret: string;
}

// Switchboard fixes the number and the caps server-side; the sandbox holds a
// token that can only ask it to ring.
export interface SwitchboardConfig {
  readonly url: string;
  /** The Secret holding the ring token as `SWITCHBOARD_RING_TOKEN`. */
  readonly secret: string;
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

/** A cluster name is also a path segment and a kubeconfig name. */
const CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function clusterName(env: Env, key: string, fallback: string): string {
  const value = text(env, key, fallback);
  if (!CLUSTER_NAME.test(value)) {
    throw new ConfigError(`${key} is not a cluster name: ${value}`);
  }
  return value;
}

function clusterNames(env: Env, key: string): readonly string[] {
  const names = [
    ...new Set(
      (env[key] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  for (const name of names) {
    if (!CLUSTER_NAME.test(name)) {
      throw new ConfigError(`${key} holds a non-cluster name: ${name}`);
    }
  }
  return names;
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

function httpUrl(env: Env, key: string): string | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {}
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new ConfigError(`${key} must be an http(s) URL, got ${raw}`);
  }
  return raw;
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** `provider/model`; the catalog check happens where the models are built. */
const MODEL_SPEC = /^[a-z0-9][a-z0-9-]*\/\S+$/;

// Settings whose meaning moved into mate's own process.
const RENAMED: Readonly<Record<string, string>> = {
  MATE_SANDBOX_MODEL: 'MATE_MODEL',
  MATE_OPENCODE_SECRET:
    'MATE_MODEL_KEY_FILE, with the Secret mounted into mate as a file',
};

function refuseRenamed(env: Env): void {
  for (const [key, replacement] of Object.entries(RENAMED)) {
    if (env[key]?.trim()) {
      throw new ConfigError(`${key} is no longer read; set ${replacement}`);
    }
  }
}

function thinking(key: string, raw: string): ThinkingLevel {
  const level = THINKING_LEVELS.find((one) => one === raw);
  if (!level) {
    throw new ConfigError(
      `${key} must be one of ${THINKING_LEVELS.join(', ')}, got ${raw}`,
    );
  }
  return level;
}

function modelSpec(env: Env, key: string, fallback: string): string {
  const model = text(env, key, fallback);
  if (!MODEL_SPEC.test(model)) {
    throw new ConfigError(`${key} must be provider/model, got ${model}`);
  }
  return model;
}

function mcpServers(env: Env): McpServerConfig[] {
  const kthxUrl = httpUrl(env, 'MATE_KTHX_MCP_URL');
  const token = env.KTHX_AGENT_TOKEN?.trim();
  const weatherUrl = httpUrl(env, 'MATE_WEATHER_MCP_URL');
  return [
    ...(kthxUrl && token
      ? [{ name: 'kthx' as const, url: kthxUrl, token }]
      : []),
    ...(weatherUrl
      ? [{ name: 'weather' as const, url: weatherUrl, token: null }]
      : []),
  ];
}

export function readBrainConfig(env: Env): BrainConfig {
  refuseRenamed(env);
  const model = modelSpec(env, 'MATE_MODEL', 'openai-codex/gpt-6-sol');
  const fallbackModel =
    text(env, 'MATE_FALLBACK_MODEL', '') === 'none'
      ? null
      : modelSpec(env, 'MATE_FALLBACK_MODEL', 'opencode-go/qwen3.8-max');
  if (fallbackModel === model) {
    throw new ConfigError(
      `MATE_FALLBACK_MODEL must differ from MATE_MODEL, both ${model}; set it to none for no fallback`,
    );
  }
  const fallbackThinking = env.MATE_FALLBACK_THINKING?.trim();
  return {
    model,
    thinking: thinking('MATE_THINKING', text(env, 'MATE_THINKING', 'medium')),
    fallbackModel,
    fallbackThinking: fallbackThinking
      ? thinking('MATE_FALLBACK_THINKING', fallbackThinking)
      : null,
    modelKeyFile: text(
      env,
      'MATE_MODEL_KEY_FILE',
      '/var/run/mate/opencode/api-key',
    ),
    databaseUrl: env.DATABASE_URL?.trim() || null,
    databaseCaFile: text(env, 'MATE_DB_CA_FILE', '/var/run/mate/db-ca/ca.crt'),
    mcpServers: mcpServers(env),
    profileRoot: env.MATE_PROFILE_DIR?.trim() || null,
    sessionRetentionDays: integer(env, 'MATE_SESSION_RETENTION_DAYS', 14, 0),
  };
}

function kthx(env: Env): KthxConfig {
  return {
    origin: httpUrl(env, 'MATE_KTHX_ORIGIN')?.replace(/\/+$/, '') ?? null,
    sitesSecret: text(env, 'MATE_KTHX_SITES_SECRET', 'mate-kthx-sites'),
  };
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

function switchboard(env: Env): SwitchboardConfig | null {
  const url = env.MATE_SWITCHBOARD_URL?.trim();
  if (!url) return null;
  return {
    url,
    secret: text(env, 'MATE_SWITCHBOARD_SECRET', 'mate-switchboard'),
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
  const kubeServiceAccount = env.MATE_SANDBOX_KUBE_SA?.trim() || null;
  const kubeReaderServiceAccount =
    env.MATE_SANDBOX_KUBE_READER_SA?.trim() || null;
  // A deploy typo must not hand read-only profiles the admin.
  if (
    kubeReaderServiceAccount &&
    kubeReaderServiceAccount === kubeServiceAccount
  ) {
    throw new ConfigError(
      'MATE_SANDBOX_KUBE_READER_SA must differ from MATE_SANDBOX_KUBE_SA',
    );
  }
  return {
    image: required(env, 'MATE_SANDBOX_IMAGE'),
    runtimeClass: text(env, 'MATE_SANDBOX_RUNTIME_CLASS', 'kata-clh'),
    namespace: env.MATE_SANDBOX_NAMESPACE?.trim() || null,
    checkoutRepo: text(
      env,
      'MATE_CHECKOUT_REPO',
      'https://github.com/jonpulsifer/infra',
    ),
    checkoutRef: text(env, 'MATE_CHECKOUT_REF', 'main'),
    turnTimeoutMs,
    spares: integer(env, 'MATE_SPARES', 0, 0),
    vault: vault(env),
    github: Boolean(env.MATE_GITHUB_APP_ID?.trim()),
    kubeServiceAccount,
    kubeReaderServiceAccount,
    kubeContext: clusterName(env, 'MATE_SANDBOX_KUBE_CONTEXT', 'cluster'),
    kubePeers: clusterNames(env, 'MATE_SANDBOX_KUBE_PEERS'),
    kthx: kthx(env),
    switchboard: switchboard(env),
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
      brain: readBrainConfig(env),
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
  refuseRenamed(env);
  const custodianChannel = env.MATE_CUSTODIAN_CHANNEL?.trim() || null;
  if (
    custodianChannel &&
    (!SLACK_ID.test(custodianChannel) ||
      !slack(env)?.allowedChannelIds.has(custodianChannel))
  ) {
    throw new ConfigError(
      'MATE_CUSTODIAN_CHANNEL must be an allowed Slack channel',
    );
  }
  return {
    token: required(env, 'DISCORD_TOKEN'),
    guildId: required(env, 'MATE_GUILD_ID'),
    allowedUserIds: ids(env, 'MATE_ALLOWED_USER_IDS'),
    allowedChannelIds: ids(env, 'MATE_ALLOWED_CHANNEL_IDS'),
    quietMs: integer(env, 'MATE_QUIET_MINUTES', 30) * 60_000,
    maxTurnsPerThread: integer(env, 'MATE_MAX_TURNS_PER_THREAD', 30),
    maxTurnsPerDay: integer(env, 'MATE_MAX_TURNS_PER_DAY', 120),
    maxConcurrent: integer(env, 'MATE_MAX_CONCURRENT', 3),
    maxSandboxes: integer(env, 'MATE_MAX_SANDBOXES', 2),
    port: integer(env, 'MATE_PORT', 8080),
    sessionFile: env.MATE_SESSION_FILE?.trim() || null,
    sandboxes: sandboxes(env),
    slack: slack(env),
    custodianChannel,
  };
}
