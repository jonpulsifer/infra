/**
 * One `agents.x-k8s.io/v1beta1` Sandbox per thread, reached by exec-ing
 * `opencode acp` in its pod. Every turn slides `spec.shutdownTime`, so a mate
 * that dies mid-thread cannot leak one.
 */
import { AcpClient } from './acp.ts';
import type { KthxConfig, SandboxConfig, VaultConfig } from './config.ts';
// Mint and revoke only, so nothing here can reach the App's private key.
export interface TokenSource {
  token(): Promise<{ token: string }>;
  revoke(token: string): Promise<void>;
}

import {
  type KthxSites,
  parseSites,
  type Sites,
  serialize,
} from './kthx-sites.ts';
import {
  type ExecClose,
  type Kube,
  KubeError,
  type KubeList,
  type KubeObject,
  kubeError,
  ok,
} from './kube.ts';
import { type Log, plain } from './log.ts';
import type { Instruments } from './metrics.ts';
import type {
  MintedRef,
  OnMintStep,
  PromptResult,
  PromptSink,
  Sandboxes,
  SandboxRef,
  Session,
  ThreadRef,
} from './sandbox.ts';
import type { SurfaceName } from './surface.ts';

export const SANDBOX_API = 'agents.x-k8s.io/v1beta1';
const SANDBOXES = '/apis/agents.x-k8s.io/v1beta1';
const PODS = '/api/v1';

export const MINTED_BY = 'mate';
export const MINTED_BY_LABEL = 'lolwtf.ca/minted-by';
export const THREAD_LABEL = 'lolwtf.ca/thread';
export const CHANNEL_LABEL = 'lolwtf.ca/channel';
export const SURFACE_LABEL = 'lolwtf.ca/surface';
// Each mate serves one Discord guild, so its id names the owning mate for
// Slack threads too, and two mates in one namespace never list each other's
// sandboxes.
export const GUILD_LABEL = 'lolwtf.ca/guild';
// `true` on an unclaimed spare; adoption swaps it for the thread labels.
// `condemned` marks one being deleted; neither the pool nor `list()` takes it.
export const SPARE_LABEL = 'lolwtf.ca/spare';
const SPARE = 'true';
const CONDEMNED = 'condemned';
// An annotation: a label value allows only 63 characters of `[A-Za-z0-9._-]`.
export const SESSION_ANNOTATION = 'lolwtf.ca/acp-session';
// Set for the length of a turn, so a mate restarted mid-turn can say so in
// the thread.
export const TURN_ANNOTATION = 'lolwtf.ca/turn-started';

export const HARNESS_CONTAINER = 'harness';
export const CHECKOUT_CONTAINER = 'checkout';
export const WORKSPACE = '/workspace';
export const AGENT_HOME = '/home/agent';
export const AGENT_UID = 1337;
// The image's user has no GECOS and no git config, so without an ident
// `git commit` fails.
const GIT_USER = 'clanky-bot[bot]';
// The numeric prefix is the bot user's id; without it GitHub links the commit
// to no account.
const GIT_EMAIL = '332275392+clanky-bot[bot]@users.noreply.github.com';
// The HTTPS username for an installation token, separate from the commit ident.
const GIT_HTTPS_USER = 'x-access-token';
// Enough recent subjects for the agent to match the repo's commit style.
const CHECKOUT_DEPTH = 50;
// Read by the credential helper and `images/mate-sandbox/gh`. The agent can
// read the token too, so it names one repository and is revoked after the turn.
const TOKEN_FILE_ENV = 'MATE_GITHUB_TOKEN_FILE';
const TOKEN_FILE = `${AGENT_HOME}/.github-token`;
const KUBECONFIG_FILE = `${AGENT_HOME}/.kube/config`;
const SSH_DIR = `${AGENT_HOME}/.ssh`;
// Where the kthx CLI keeps its site tokens under the image's XDG_CONFIG_HOME.
const KTHX_SITES_FILE = `${AGENT_HOME}/.config/kthx/sites.json`;
const KTHX_TOKEN_ENV = 'KTHX_AGENT_TOKEN';
const SSH_KEY_FILE = `${SSH_DIR}/id_ed25519`;
const SSH_CONFIG_FILE = `${SSH_DIR}/config`;
// accept-new: home is a fresh emptyDir with no known hosts, so `yes` refuses
// every host, and `no` would accept a changed key.
const SSH_CLIENT_CONFIG = [
  'Host *',
  '  User rowbutt',
  `  IdentityFile ${SSH_KEY_FILE}`,
  '  IdentitiesOnly yes',
  '  StrictHostKeyChecking accept-new',
  `  UserKnownHostsFile ${SSH_DIR}/known_hosts`,
  '',
].join('\n');
// Both the token audience and the server address: a bound token is refused
// by any audience it was not minted for.
const CLUSTER_URL = 'https://kubernetes.default.svc:443';
// Outlives the turn, so the token never expires under a running `kubectl`.
const TOKEN_SLACK_SECONDS = 5 * 60;
// The apiserver refuses a TokenRequest under ten minutes.
const TOKEN_FLOOR_SECONDS = 600;
// git asks every matching helper in config order and the first answer wins.
// `gitEnv` sets it empty first, which clears earlier helpers for this URL.
const CREDENTIAL_KEY = 'credential.https://github.com.helper';
// Answers `get` only; git also calls a helper to store and erase. An empty
// file exits 1, since git would report a blank password as a rejected one.
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; t=$(cat "$${TOKEN_FILE_ENV}" 2>/dev/null) || exit 1; test -n "$t" || exit 1; printf "username=${GIT_HTTPS_USER}\\npassword=%s\\n" "$t"; }; f`;

export const TTL_MS = 2 * 60 * 60_000;
// Only a sweep renews a spare, so this bounds what a dead mate leaves on the
// node. Six sweeps fit, so a few failed sweeps cannot reap a healthy spare.
export const SPARE_TTL_MS = 30 * 60_000;
export const SPARE_SWEEP_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 300_000;
const REFRESH_TIMEOUT_MS = 60_000;
// A few `printf`s on a live pod; a slow write has gone wrong and holds up
// the turn.
const STAMP_TIMEOUT_MS = 15_000;
const GONE_TIMEOUT_MS = 180_000;
const REAP_TIMEOUT_MS = 15_000;
const WATCH_SECONDS = 60;
// Without a pause, a watch that ends with no event re-lists as fast as the
// apiserver answers.
const WATCH_IDLE_MS = 1_000;
const STDERR_LIMIT = 500;
// A provider error can echo `OPENCODE_API_KEY` from the harness environment.
const SECRET_SHAPED =
  /(?:sk-[A-Za-z0-9._-]{8,}|[Bb]earer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9_-]{32,})/g;
// CRDs reject strategic merge; a merge patch leaves sibling fields alone.
const MERGE_PATCH = 'application/merge-patch+json';

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface SandboxStatus {
  conditions?: Condition[];
  /** The label selector the controller sets on the backing pod. */
  selector?: string;
  podIPs?: string[];
  nodeName?: string;
}

export type Sandbox = KubeObject<Record<string, unknown>, SandboxStatus>;
type Pod = KubeObject<Record<string, unknown>, { phase?: string }>;

export interface KubeSandboxesDeps {
  kube: Kube;
  config: SandboxConfig;
  guildId: string;
  log: Log;
  /** Absent in the smoke harness, which runs with no metrics SDK. */
  metrics?: Instruments;
  /** Absent when no App is configured. */
  githubApp?: TokenSource | null;
  /** Absent when `config.kthx.origin` is unset. */
  kthxSites?: KthxSites | null;
  clusterCa?: string | null;
  sshKey?: string | null;
  ttlMs?: number;
  readyTimeoutMs?: number;
  goneTimeoutMs?: number;
}

interface Attachment {
  client: AcpClient;
  sessionId: string;
  pod: string;
}

const SNOWFLAKE = /^\d{15,22}$/;
const SLACK_CHANNEL = /^[A-Z][A-Z0-9]{1,20}$/;
const SLACK_TS = /^\d{10}\.\d{6}$/;

// Every part is also a label value, so each surface's ids are validated first.
export function sandboxName(thread: ThreadRef): string {
  if (thread.surface === 'discord') {
    if (!SNOWFLAKE.test(thread.id)) {
      throw new Error(`thread id ${thread.id} is not a snowflake`);
    }
    return `mate-${thread.id}`;
  }
  if (!SLACK_CHANNEL.test(thread.channelId) || !SLACK_TS.test(thread.id)) {
    throw new Error(
      `thread ${thread.channelId}/${thread.id} is not a Slack thread`,
    );
  }
  return `mate-slack-${thread.channelId.toLowerCase()}-${thread.id.replace('.', '-')}`;
}

// An adopted spare keeps this name; threads find their sandbox by label.
function spareName(): string {
  return `mate-spare-${crypto.randomUUID().slice(0, 8)}`;
}

// Reset, since a pull would merge into a shallow history. The ref arrives as
// "$1" so the shell never parses a branch name.
function refreshScript(): string {
  return `set -e; cd ${WORKSPACE}; git fetch --depth 1 origin "$1"; git reset --hard FETCH_HEAD`;
}

function condition(sandbox: Sandbox, type: string): Condition | undefined {
  return sandbox.status?.conditions?.find((c) => c.type === type);
}

export function isReady(sandbox: Sandbox): boolean {
  return condition(sandbox, 'Ready')?.status === 'True';
}

function whyNotReady(sandbox: Sandbox): string {
  const ready = condition(sandbox, 'Ready');
  if (!ready) return 'no Ready condition yet';
  return (
    [ready.reason, ready.message].filter(Boolean).join(': ') || 'not ready'
  );
}

const CONTAINER_SECURITY = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ['ALL'] },
  runAsNonRoot: true,
  runAsUser: AGENT_UID,
  seccompProfile: { type: 'RuntimeDefault' },
};

// A digest-pinned image cannot change, so a cached copy is never stale.
function pullPolicy(image: string): string {
  return image.includes('@sha256:') ? 'IfNotPresent' : 'Always';
}

// Paths are absolute: opencode resolves a relative one against its own config
// directory, and reports neither that nor a missing file.
export function opencodeConfig(
  model: string,
  kthxMcpUrl: string | null = null,
): string {
  return JSON.stringify({
    model,
    // Project config, which would load AGENTS.md, is turned off.
    instructions: [`${WORKSPACE}/AGENTS.md`],
    // opencode's own skill walk looks only in `.agents/` and `.claude/`.
    skills: { paths: [`${WORKSPACE}/dotfiles/skills`] },
    permission: 'allow',
    autoupdate: false,
    share: 'disabled',
    // opencode substitutes `{env:…}` itself, an unset variable as ''. Without
    // `oauth: false` a 401 starts OAuth discovery against the engine.
    ...(kthxMcpUrl
      ? {
          mcp: {
            kthx: {
              type: 'remote',
              url: kthxMcpUrl,
              enabled: true,
              headers: { Authorization: `Bearer {env:${KTHX_TOKEN_ENV}}` },
              oauth: false,
              timeout: 10_000,
            },
          },
        }
      : {}),
  });
}

// With no CA the sandbox trusts the system store, as mate does. It never gets
// `insecure-skip-tls-verify`.
export function kubeconfig(token: string, ca: string | null): string {
  const cluster = [
    `    server: ${CLUSTER_URL}`,
    ...(ca
      ? [
          `    certificate-authority-data: ${Buffer.from(ca).toString('base64')}`,
        ]
      : []),
  ];
  return [
    'apiVersion: v1',
    'kind: Config',
    'clusters:',
    '  - name: cluster',
    '    cluster:',
    ...cluster,
    'users:',
    '  - name: sandbox',
    '    user:',
    `      token: ${token}`,
    'contexts:',
    '  - name: cluster',
    '    context:',
    '      cluster: cluster',
    '      user: sandbox',
    'current-context: cluster',
    '',
  ].join('\n');
}

// Command-scope config, where git honours `safe.directory`: the emptyDir mount
// root stays uid 0 under fsGroup, so git would fail on `dubious ownership`.
export function gitEnv(github: boolean): { name: string; value: string }[] {
  const settings: [string, string][] = [
    ['safe.directory', WORKSPACE],
    ['user.name', GIT_USER],
    ['user.email', GIT_EMAIL],
  ];
  if (github) {
    settings.push([CREDENTIAL_KEY, ''], [CREDENTIAL_KEY, CREDENTIAL_HELPER]);
  }
  return [
    { name: 'GIT_CONFIG_COUNT', value: String(settings.length) },
    ...settings.flatMap(([key, value], index) => [
      { name: `GIT_CONFIG_KEY_${index}`, value: key },
      { name: `GIT_CONFIG_VALUE_${index}`, value },
    ]),
    // Without this, a failed helper leaves git prompting for a username, which
    // blocks whenever the agent's tool gave the command a terminal.
    ...(github
      ? [
          { name: 'GIT_TERMINAL_PROMPT', value: '0' },
          { name: TOKEN_FILE_ENV, value: TOKEN_FILE },
        ]
      : []),
  ];
}

// Never add `OP_SERVICE_ACCOUNT_TOKEN`: with `OP_CONNECT_HOST` also set, `op`
// silently takes the Connect path, and the other token hangs it.
function connectEnv(vault: VaultConfig): Record<string, unknown>[] {
  return [
    { name: 'OP_CONNECT_HOST', value: vault.connectHost },
    {
      name: 'OP_CONNECT_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: vault.connectSecret,
          key: 'OP_CONNECT_TOKEN',
          // A missing Secret would hold every sandbox in
          // CreateContainerConfigError.
          optional: true,
        },
      },
    },
  ];
}

// The agent token is minted by the owner in the console, so the Secret can be
// absent; `optional`, as the Connect token is, keeps that from holding every
// sandbox in CreateContainerConfigError.
function kthxEnv(kthx: KthxConfig): Record<string, unknown>[] {
  return [
    ...(kthx.origin ? [{ name: 'KTHX_ORIGIN', value: kthx.origin }] : []),
    ...(kthx.mcpUrl
      ? [
          {
            name: KTHX_TOKEN_ENV,
            valueFrom: {
              secretKeyRef: {
                name: kthx.agentSecret,
                key: KTHX_TOKEN_ENV,
                optional: true,
              },
            },
          },
        ]
      : []),
  ];
}

export interface SandboxDeclaration {
  name: string;
  namespace: string;
  /** Applied to both the object and its pod template. */
  labels: Record<string, string>;
  config: SandboxConfig;
  shutdownTime: string;
}

function baseLabels(guildId: string): Record<string, string> {
  return {
    // `sandbox-network-policy.yaml` selects on this; a sandbox without it has
    // unrestricted egress.
    'app.kubernetes.io/name': 'mate-sandbox',
    'app.kubernetes.io/part-of': 'mate',
    [MINTED_BY_LABEL]: MINTED_BY,
    [GUILD_LABEL]: guildId,
  };
}

function threadLabels(thread: ThreadRef): Record<string, string> {
  return {
    [SURFACE_LABEL]: thread.surface,
    [THREAD_LABEL]: thread.id,
    [CHANNEL_LABEL]: thread.channelId,
  };
}

export function sandboxLabels(
  thread: ThreadRef,
  guildId: string,
): Record<string, string> {
  return { ...baseLabels(guildId), ...threadLabels(thread) };
}

function spareLabels(guildId: string): Record<string, string> {
  return { ...baseLabels(guildId), [SPARE_LABEL]: SPARE };
}

// In a merge patch, null removes a label.
function claimLabels(thread: ThreadRef): Record<string, string | null> {
  return { ...threadLabels(thread), [SPARE_LABEL]: null };
}

function condemnLabels(): Record<string, string | null> {
  return {
    [SURFACE_LABEL]: null,
    [THREAD_LABEL]: null,
    [CHANNEL_LABEL]: null,
    [SPARE_LABEL]: CONDEMNED,
  };
}

export function sandboxManifest(declaration: SandboxDeclaration): Sandbox {
  const { name, namespace, labels, config, shutdownTime } = declaration;
  return {
    apiVersion: SANDBOX_API,
    kind: 'Sandbox',
    metadata: { name, namespace, labels },
    spec: {
      // The controller deletes the sandbox at this time, even with mate gone.
      // Every turn slides it.
      shutdownTime,
      shutdownPolicy: 'Delete',
      podTemplate: {
        metadata: { labels },
        spec: {
          runtimeClassName: config.runtimeClass,
          // No node is tainted, so this term alone keeps agent commands off
          // a control-plane node.
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [
                  {
                    matchExpressions: [
                      {
                        key: 'node-role.kubernetes.io/control-plane',
                        operator: 'DoesNotExist',
                      },
                    ],
                  },
                ],
              },
            },
          },
          restartPolicy: 'Always',
          automountServiceAccountToken: false,
          // The agent runs arbitrary commands and gets no Service addresses.
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: AGENT_UID,
            runAsGroup: AGENT_UID,
            // Makes the emptyDirs writable by the agent's group, so the
            // checkout can clone as a non-root user.
            fsGroup: AGENT_UID,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          initContainers: [
            {
              name: CHECKOUT_CONTAINER,
              image: config.image,
              imagePullPolicy: pullPolicy(config.image),
              command: [
                'git',
                'clone',
                '--depth',
                String(CHECKOUT_DEPTH),
                '--branch',
                config.checkoutRef,
                config.checkoutRepo,
                WORKSPACE,
              ],
              env: gitEnv(false),
              volumeMounts: [{ name: 'workspace', mountPath: WORKSPACE }],
              securityContext: CONTAINER_SECURITY,
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { memory: '512Mi' },
              },
            },
          ],
          containers: [
            {
              name: HARNESS_CONTAINER,
              image: config.image,
              imagePullPolicy: pullPolicy(config.image),
              env: [
                {
                  name: 'OPENCODE_API_KEY',
                  valueFrom: {
                    secretKeyRef: {
                      name: config.secret,
                      key: 'OPENCODE_API_KEY',
                    },
                  },
                },
                {
                  name: 'OPENCODE_CONFIG_CONTENT',
                  value: opencodeConfig(config.model, config.kthx.mcpUrl),
                },
                // opencode npm-installs a plugin into any `.opencode/` it
                // loads, and npm is outside the sandbox's egress allow-list.
                { name: 'OPENCODE_DISABLE_PROJECT_CONFIG', value: '1' },
                ...(config.vault ? connectEnv(config.vault) : []),
                ...kthxEnv(config.kthx),
                ...gitEnv(config.github),
                ...(config.kubeServiceAccount
                  ? [{ name: 'KUBECONFIG', value: KUBECONFIG_FILE }]
                  : []),
              ],
              volumeMounts: [
                { name: 'home', mountPath: AGENT_HOME },
                { name: 'workspace', mountPath: WORKSPACE },
              ],
              securityContext: CONTAINER_SECURITY,
              resources: {
                requests: { cpu: '250m', memory: '512Mi' },
                limits: { cpu: '2000m', memory: '4Gi' },
              },
            },
          ],
          volumes: [
            { name: 'home', emptyDir: {} },
            { name: 'workspace', emptyDir: {} },
          ],
        },
      },
    },
  };
}

// Via `status.selector`: the controller does not set the
// `agents.x-k8s.io/pod-name` annotation.
export async function resolvePod(
  kube: Kube,
  namespace: string,
  sandbox: Sandbox,
): Promise<string> {
  const name = sandbox.metadata.name;
  const selector = sandbox.status?.selector;
  if (!selector) throw new Error(`sandbox ${name} reports no pod selector`);
  const pods = await kube.json<KubeList<Pod>>(
    `${PODS}/namespaces/${namespace}/pods`,
    { query: { labelSelector: selector } },
  );
  const uid = sandbox.metadata.uid;
  const pod = pods.items.find(
    (candidate) =>
      !candidate.metadata.deletionTimestamp &&
      candidate.status?.phase === 'Running' &&
      (!uid ||
        (candidate.metadata.ownerReferences ?? []).some((o) => o.uid === uid)),
  );
  if (!pod) {
    throw new Error(`sandbox ${name} has no running pod for ${selector}`);
  }
  return pod.metadata.name;
}

async function waitUntilGone(
  kube: Kube,
  path: string,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const query = { fieldSelector: `metadata.name=${name}` };
  for (;;) {
    const list = await kube.json<KubeList<unknown>>(path, { query });
    if (list.items.length === 0) return;
    const left = deadline - Date.now();
    if (left <= 0) break;
    const events = kube.watch<unknown>(
      path,
      { ...query, resourceVersion: list.metadata.resourceVersion ?? '' },
      Math.min(WATCH_SECONDS, Math.ceil(left / 1000)),
    );
    let saw = false;
    for await (const event of events) {
      saw = true;
      if (event.type === 'DELETED') return;
    }
    if (!saw) await idle(deadline);
  }
  throw new Error(`${name} was still there after ${timeoutMs / 1000}s`);
}

export function waitForPodGone(
  kube: Kube,
  namespace: string,
  pod: string,
  timeoutMs = GONE_TIMEOUT_MS,
): Promise<void> {
  return waitUntilGone(
    kube,
    `${PODS}/namespaces/${namespace}/pods`,
    pod,
    timeoutMs,
  );
}

export class KubeSandboxes implements Sandboxes {
  private readonly attached = new Map<string, Attachment>();
  // The ledger as last saved and written into each sandbox, for the fold at
  // the turn's end. Empty after a restart, which folds every site as new.
  private readonly stamped = new Map<string, Sites>();
  private warming: Promise<void> | null = null;
  private again = false;
  private inherited = true;

  constructor(private readonly deps: KubeSandboxesDeps) {}

  get namespace(): string {
    return this.deps.config.namespace ?? this.deps.kube.namespace;
  }

  async list(): Promise<SandboxRef[]> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: { labelSelector: this.selector() },
    });
    const refs: SandboxRef[] = [];
    for (const sandbox of list.items) {
      if (sandbox.metadata.deletionTimestamp) continue;
      const labels = sandbox.metadata.labels ?? {};
      // Spares and condemned sandboxes carry no thread labels by design.
      if (labels[SPARE_LABEL]) continue;
      const id = labels[THREAD_LABEL];
      const channelId = labels[CHANNEL_LABEL];
      // Discord sandboxes can predate the surface label.
      const surface = (labels[SURFACE_LABEL] ?? 'discord') as SurfaceName;
      if (!id || !channelId) {
        this.deps.log.warn('sandbox has no thread labels; ignoring it', {
          sandbox: sandbox.metadata.name,
        });
        continue;
      }
      refs.push({
        name: sandbox.metadata.name,
        thread: { surface, channelId, id },
        turnInFlight: Boolean(sandbox.metadata.annotations?.[TURN_ANNOTATION]),
      });
    }
    return refs;
  }

  async mint(thread: ThreadRef, onStep?: OnMintStep): Promise<MintedRef> {
    const existing = await this.find(thread);
    if (existing) return this.reuse(existing, thread, onStep);
    const taken = await this.adopt(thread, onStep);
    if (taken) {
      // Refill in the background: this thread should not wait for it.
      void this.ensureSpares().catch((error) =>
        this.deps.log.warn('minting a replacement spare failed', {
          error: plain(error),
        }),
      );
      return taken;
    }
    return this.mintFresh(thread, onStep);
  }

  /**
   * A call during a pass queues one more pass, because the running one counted
   * the pool before this call's change.
   */
  async ensureSpares(): Promise<void> {
    if (this.warming) {
      this.again = true;
      return this.warming;
    }
    this.warming = this.passes();
    return this.warming;
  }

  private async passes(): Promise<void> {
    try {
      do {
        this.again = false;
        await this.sweep();
      } while (this.again);
    } finally {
      this.warming = null;
    }
  }

  async attach(ref: SandboxRef): Promise<Session> {
    const { kube, log } = this.deps;
    this.detach(ref.name);
    const sandbox = await kube.json<Sandbox>(this.path(ref.name));
    if (!isReady(sandbox)) {
      throw new Error(
        `sandbox ${ref.name} is not ready: ${whyNotReady(sandbox)}`,
      );
    }
    const pod = await resolvePod(kube, this.namespace, sandbox);
    const stored = sandbox.metadata.annotations?.[SESSION_ANNOTATION];
    if (stored) await this.reap(ref.name, pod);
    const exec = await kube.exec({
      namespace: this.namespace,
      pod,
      container: HARNESS_CONTAINER,
      command: ['opencode', 'acp', '--cwd', WORKSPACE],
      onStderr: (text) => {
        const line = redactStderr(text);
        if (line) log.warn('harness stderr', { sandbox: ref.name, line });
      },
    });
    const client = new AcpClient(exec, log, { sandbox: ref.name, pod });
    let session: { id: string; resumed: boolean };
    // Register only once the session and TTL are stored; a failed attach
    // closes its harness.
    try {
      await client.initialize();
      session = await this.openSession(client, ref.name, stored);
      if (session.id !== stored) await this.remember(ref.name, session.id);
      await this.slide(ref.name);
    } catch (error) {
      client.close();
      throw error;
    }
    const attachment: Attachment = { client, sessionId: session.id, pod };
    this.attached.set(ref.name, attachment);
    void client.closed.then((close) => {
      if (this.attached.get(ref.name) === attachment) {
        this.attached.delete(ref.name);
      }
      log.warn('harness stream closed', {
        sandbox: ref.name,
        code: close.code,
        reason: close.reason,
      });
    });
    return { id: session.id, sandbox: ref, resumed: session.resumed };
  }

  async prompt(
    session: Session,
    text: string,
    sink: PromptSink,
  ): Promise<PromptResult> {
    const name = session.sandbox.name;
    const attachment = this.attached.get(name);
    if (!attachment || attachment.sessionId !== session.id) {
      throw new Error(`sandbox ${name} is not attached`);
    }
    await this.mark(name).catch((error) =>
      this.deps.log.warn('turn mark failed', {
        sandbox: name,
        error: plain(error),
      }),
    );
    const token = await this.stampToken(name, attachment.pod);
    let result: PromptResult;
    try {
      result = await attachment.client.prompt(
        session.id,
        text,
        sink,
        this.deps.config.turnTimeoutMs,
      );
    } finally {
      // Every way a turn ends, a throw included, clears the turn's credentials.
      await this.retireToken(name, attachment.pod, token);
    }
    // The answer stands: a failed slide leaves only a shorter TTL and a
    // stale turn mark.
    await this.slide(name).catch((error) =>
      this.deps.log.warn('shutdownTime slide failed', {
        sandbox: name,
        error: plain(error),
      }),
    );
    return {
      stopReason: result.stopReason,
      error: result.error,
      firstTokenMs: result.firstTokenMs,
      costUsd: result.costUsd,
    };
  }

  private get credentialled(): boolean {
    return Boolean(
      this.deps.githubApp ||
        this.deps.config.kubeServiceAccount ||
        this.deps.sshKey ||
        this.kthx,
    );
  }

  private get kthx(): KthxSites | null {
    return this.deps.config.kthx.origin ? (this.deps.kthxSites ?? null) : null;
  }

  // Never fails the turn: a thread that cannot push can still answer, and the
  // metric and the `gh` wrapper report the missing token.
  private async stampToken(name: string, pod: string): Promise<string | null> {
    const { githubApp, log, metrics } = this.deps;
    if (!this.credentialled) return null;
    const github = githubApp ? await this.mintGithub(name) : null;
    const kube = await this.mintCluster(name);
    const ssh = this.deps.sshKey ?? '';
    // First, so a save the last turn's end could not make is retried now.
    const sites = this.kthx ? await this.syncSites(name, pod) : null;
    try {
      await this.writeCredentials(pod, {
        github: github ?? '',
        kube,
        ssh,
        kthx: sites ? serialize(sites) : null,
      });
      if (githubApp) metrics?.githubTokenStamped(github ? 'ok' : 'mint-failed');
      return github;
    } catch (error) {
      metrics?.githubTokenStamped('stamp-failed');
      log.error("could not stamp the turn's credentials into the sandbox", {
        sandbox: name,
        error: plain(error),
      });
      // Revoke now, since it reached nobody. A cluster token cannot be
      // revoked and expires on its own.
      if (github) await githubApp?.revoke(github).catch(() => {});
      return null;
    }
  }

  /** `null` when minting failed; the reason is already logged. */
  private async mintGithub(name: string): Promise<string | null> {
    const { githubApp, log, metrics } = this.deps;
    try {
      const token = (await githubApp?.token())?.token ?? null;
      metrics?.githubTokenMinted('ok');
      return token;
    } catch (error) {
      metrics?.githubTokenMinted('mint-failed');
      log.error('could not mint a GitHub token for this turn', {
        sandbox: name,
        error: plain(error),
      });
      return null;
    }
  }

  /**
   * `''` means no cluster access. A bound token cannot be revoked, so its
   * expiry bounds any copy taken during the turn.
   */
  private async mintCluster(name: string): Promise<string> {
    const { config, kube, log } = this.deps;
    const account = config.kubeServiceAccount;
    if (!account) return '';
    const seconds = Math.max(
      TOKEN_FLOOR_SECONDS,
      Math.ceil(config.turnTimeoutMs / 1000) + TOKEN_SLACK_SECONDS,
    );
    try {
      const minted = await kube.json<{ status?: { token?: string } }>(
        `/api/v1/namespaces/${this.namespace}/serviceaccounts/${account}/token`,
        {
          method: 'POST',
          body: {
            apiVersion: 'authentication.k8s.io/v1',
            kind: 'TokenRequest',
            spec: { audiences: [CLUSTER_URL], expirationSeconds: seconds },
          },
        },
      );
      const token = minted.status?.token;
      if (!token) throw new Error('TokenRequest answered no token');
      return kubeconfig(token, this.deps.clusterCa ?? null);
    } catch (error) {
      log.error('could not mint cluster access for this turn', {
        sandbox: name,
        serviceAccount: account,
        error: plain(error),
      });
      return '';
    }
  }

  /** Truncates every credential file, then revokes the GitHub token. */
  private async retireToken(
    name: string,
    pod: string,
    token: string | null,
  ): Promise<void> {
    if (!this.credentialled) return;
    // Truncated only once the ledger holds what it said; otherwise the file
    // is the only copy of the turn's claims, and the next turn retries.
    const synced = this.kthx ? await this.syncSites(name, pod) : null;
    try {
      await this.writeCredentials(pod, {
        github: '',
        kube: '',
        ssh: '',
        kthx: synced ? '' : null,
      });
      // An empty file is what the next turn reads first, and it must fold
      // in as nothing claimed, not as every site removed.
      if (synced) this.stamped.set(name, {});
    } catch (error) {
      this.deps.log.warn("could not clear the turn's credentials", {
        sandbox: name,
        error: plain(error),
      });
    }
    if (!token) return;
    await this.deps.githubApp?.revoke(token).catch((error: unknown) =>
      this.deps.log.warn('could not revoke the GitHub token', {
        sandbox: name,
        error: plain(error),
      }),
    );
  }

  /**
   * Reads the sandbox's kthx site tokens back into the ledger. Answers what
   * the file should hold now, or `null` to leave it alone: an unreadable file
   * may hold tokens nobody else has, and after a failed save it is their only
   * copy. `read-failed` is the file, `save-failed` the Secret.
   */
  private async syncSites(name: string, pod: string): Promise<Sites | null> {
    const { log, metrics } = this.deps;
    const ledger = this.kthx;
    if (!ledger) return null;
    let harvested: Sites;
    try {
      harvested = parseSites(
        await this.execText(pod, [
          '/bin/sh',
          '-c',
          `cat ${KTHX_SITES_FILE} 2>/dev/null || true`,
        ]),
      );
    } catch (error) {
      metrics?.kthxSitesSynced('read-failed');
      log.error('could not read the sandbox kthx sites file', {
        sandbox: name,
        error: plain(error),
      });
      return null;
    }
    try {
      const sites = await ledger.merge(this.stamped.get(name) ?? {}, harvested);
      metrics?.kthxSitesSynced('ok');
      this.stamped.set(name, sites);
      return sites;
    } catch (error) {
      metrics?.kthxSitesSynced('save-failed');
      log.error('could not save the sandbox kthx sites into the ledger', {
        sandbox: name,
        secret: ledger.secret,
        error: plain(error),
      });
      return null;
    }
  }

  // stdin is never closed: the stream has no half-close, and kata-clh drops
  // stdout after an EOF on it.
  private async execText(pod: string, command: string[]): Promise<string> {
    const stream = await this.deps.kube.exec({
      namespace: this.namespace,
      pod,
      container: HARNESS_CONTAINER,
      command,
      timeoutMs: STAMP_TIMEOUT_MS,
    });
    const timer = setTimeout(() => stream.close(), STAMP_TIMEOUT_MS);
    let text: string;
    let close: ExecClose;
    try {
      [text, close] = await Promise.all([
        new Response(stream.stdout).text(),
        stream.closed,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (close.status?.status !== 'Success') {
      throw new Error(
        `${command[0]} said ${close.status?.message || close.reason}`,
      );
    }
    return text;
  }

  // One exec for every file, since a human is waiting on the turn. A null
  // `kthx` leaves the sites file alone.
  private async writeCredentials(
    pod: string,
    values: { github: string; kube: string; ssh: string; kthx: string | null },
  ): Promise<void> {
    const sites = values.kthx;
    const stream = await this.deps.kube.exec({
      namespace: this.namespace,
      pod,
      container: HARNESS_CONTAINER,
      command: [
        '/bin/sh',
        '-c',
        [
          // First, so no file is ever briefly readable by others; ssh refuses
          // a key that is.
          'umask 077',
          `mkdir -p ${SSH_DIR} "$(dirname ${KUBECONFIG_FILE})"${
            sites === null ? '' : ` "$(dirname ${KTHX_SITES_FILE})"`
          }`,
          `printf %s "$1" > ${TOKEN_FILE}`,
          `printf %s "$2" > ${KUBECONFIG_FILE}`,
          `printf %s "$3" > ${SSH_KEY_FILE}`,
          `printf %s "$4" > ${SSH_CONFIG_FILE}`,
          ...(sites === null ? [] : [`printf %s "$5" > ${KTHX_SITES_FILE}`]),
        ].join('; '),
        // Values go in argv, since `ExecStream` cannot half-close stdin. That
        // puts them in the apiserver audit log wherever auditing is on.
        'mate',
        values.github,
        values.kube,
        values.ssh,
        // No key, no client config pointing ssh at one.
        values.ssh ? SSH_CLIENT_CONFIG : '',
        ...(sites === null ? [] : [sites]),
      ],
      timeoutMs: STAMP_TIMEOUT_MS,
    });
    void stream.stdout.cancel().catch(() => {});
    const timer = setTimeout(() => stream.close(), STAMP_TIMEOUT_MS);
    let close: ExecClose;
    try {
      close = await stream.closed;
    } finally {
      clearTimeout(timer);
    }
    // No status means nobody saw the exit, and the files may be empty.
    if (close.status?.status !== 'Success') {
      throw new Error(
        `writing the token said ${close.status?.message || close.reason}`,
      );
    }
  }

  async cancel(session: Session): Promise<void> {
    // After a failed `session/load` the attachment holds a new session id,
    // and cancelling the old one stops nothing.
    const attachment = this.attached.get(session.sandbox.name);
    if (attachment?.sessionId !== session.id) return;
    await attachment.client.cancel(session.id);
  }

  async teardown(ref: SandboxRef): Promise<void> {
    if (this.kthx) await this.keepSites(ref);
    await this.destroy(ref.name);
    this.stamped.delete(ref.name);
  }

  // Best effort, before the delete takes the file with it.
  private async keepSites(ref: SandboxRef): Promise<void> {
    try {
      await this.syncSites(ref.name, await this.podOf(ref));
    } catch (error) {
      // 404: gone already, and its home with it.
      if (error instanceof KubeError && error.status === 404) return;
      this.deps.log.warn(
        'could not keep the sandbox kthx sites before teardown',
        { sandbox: ref.name, error: plain(error) },
      );
    }
  }

  async podOf(ref: SandboxRef): Promise<string> {
    const sandbox = await this.deps.kube.json<Sandbox>(this.path(ref.name));
    return resolvePod(this.deps.kube, this.namespace, sandbox);
  }

  private path(name?: string): string {
    const base = `${SANDBOXES}/namespaces/${this.namespace}/sandboxes`;
    return name ? `${base}/${name}` : base;
  }

  private selector(): string {
    return `${MINTED_BY_LABEL}=${MINTED_BY},${GUILD_LABEL}=${this.deps.guildId}`;
  }

  private shutdownTime(): string {
    return new Date(Date.now() + (this.deps.ttlMs ?? TTL_MS)).toISOString();
  }

  private spareShutdownTime(): string {
    return new Date(Date.now() + SPARE_TTL_MS).toISOString();
  }

  private spareSelector(): string {
    return `${this.selector()},${SPARE_LABEL}=${SPARE}`;
  }

  /**
   * By label, since an adopted spare's name derives from no thread. A
   * terminating object is skipped, because `reuse` fails on it.
   */
  private async find(thread: ThreadRef): Promise<Sandbox | undefined> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: {
        labelSelector: `${this.selector()},${THREAD_LABEL}=${thread.id}`,
      },
    });
    // Checked, not selected on: older Discord sandboxes carry only the thread
    // label. A Slack `thread_ts` is unique per channel only.
    return list.items
      .filter((found) => !found.metadata.deletionTimestamp)
      .find((found) => {
        const labels = found.metadata.labels ?? {};
        return (
          (labels[SURFACE_LABEL] ?? 'discord') === thread.surface &&
          (labels[CHANNEL_LABEL] ?? thread.channelId) === thread.channelId
        );
      });
  }

  private async reuse(
    existing: Sandbox,
    thread: ThreadRef,
    onStep?: OnMintStep,
  ): Promise<MintedRef> {
    const name = existing.metadata.name;
    if (existing.metadata.deletionTimestamp) {
      throw new Error(`sandbox ${name} is still terminating`);
    }
    this.deps.log.info('sandbox already existed', { sandbox: name });
    onStep?.('reusing');
    await this.waitUsable(name);
    return { name, thread, source: 'reused' };
  }

  private async mintFresh(
    thread: ThreadRef,
    onStep?: OnMintStep,
  ): Promise<MintedRef> {
    const { kube } = this.deps;
    const name = sandboxName(thread);
    onStep?.('creating');
    const response = await kube.request(this.path(), {
      method: 'POST',
      body: sandboxManifest({
        name,
        namespace: this.namespace,
        labels: sandboxLabels(thread, this.deps.guildId),
        config: this.deps.config,
        shutdownTime: this.shutdownTime(),
      }),
    });
    if (!ok(response, 409)) throw await kubeError(response);
    await drain(response);
    // `find` saw nothing, so a 409 means an object without our labels holds
    // the name.
    if (response.status === 409) {
      return this.reuse(
        await kube.json<Sandbox>(this.path(name)),
        thread,
        onStep,
      );
    }
    onStep?.('booting');
    await this.waitUsable(name);
    return { name, thread, source: 'fresh' };
  }

  private async waitUsable(name: string): Promise<void> {
    try {
      await this.waitReady(name);
    } catch (error) {
      // `shutdownTime` is hours away, and an abandoned sandbox could still
      // start later with nobody to talk to.
      await this.destroy(name).catch((failure) =>
        this.deps.log.warn('could not delete a sandbox that never came up', {
          sandbox: name,
          error: plain(failure),
        }),
      );
      throw error;
    }
  }

  private async adopt(
    thread: ThreadRef,
    onStep?: OnMintStep,
  ): Promise<MintedRef | null> {
    const { config, log } = this.deps;
    // Pool off: skip the list, so an apiserver hiccup cannot cost a thread
    // its answer.
    if (config.spares === 0) return null;
    const labels = claimLabels(thread);
    for (const spare of await this.spares()) {
      if (!isReady(spare)) continue;
      const name = spare.metadata.name;
      onStep?.('adopting');
      try {
        await this.patch(name, {
          metadata: {
            // Conditional on the listed revision: of two threads racing for
            // one spare, the second gets a 409.
            resourceVersion: spare.metadata.resourceVersion,
            labels,
          },
          spec: {
            shutdownTime: this.shutdownTime(),
            // The controller copies template labels onto the running pod.
            podTemplate: { metadata: { labels } },
          },
        });
      } catch (error) {
        if (error instanceof KubeError && error.status === 409) {
          log.info('a spare was taken while this thread was reaching for it', {
            sandbox: name,
          });
          continue;
        }
        throw error;
      }
      onStep?.('refreshing');
      try {
        await this.refresh(spare);
      } catch (error) {
        // The caller mints a replacement, so `condemn` strips the thread
        // labels first. If that patch fails, the mint fails too.
        log.warn('could not bring an adopted spare up to date; minting one', {
          sandbox: name,
          error: plain(error),
        });
        await this.condemn(name);
        return null;
      }
      log.info('adopted a warm spare', {
        sandbox: name,
        surface: thread.surface,
        threadId: thread.id,
      });
      return { name, thread, source: 'spare' };
    }
    return null;
  }

  /**
   * The patch is awaited because it makes the object unreachable; the delete
   * is not. Pass a listed `resourceVersion` to leave a moved object alone.
   */
  private async condemn(name: string, resourceVersion?: string): Promise<void> {
    const labels = condemnLabels();
    await this.patch(name, {
      metadata: { labels, ...(resourceVersion ? { resourceVersion } : {}) },
      spec: { podTemplate: { metadata: { labels } } },
    });
    void this.destroy(name).catch((failure) =>
      this.deps.log.warn('could not delete a condemned sandbox', {
        sandbox: name,
        error: plain(failure),
      }),
    );
  }

  // Before the ACP attach, because opencode snapshots the workspace as it
  // finds it.
  private async refresh(spare: Sandbox): Promise<void> {
    const { kube, config, log } = this.deps;
    const name = spare.metadata.name;
    const pod = await resolvePod(kube, this.namespace, spare);
    let said = '';
    const stream = await kube.exec({
      namespace: this.namespace,
      pod,
      container: HARNESS_CONTAINER,
      command: ['/bin/sh', '-c', refreshScript(), 'mate', config.checkoutRef],
      onStderr: (text) => {
        // Redacted as it arrives, because it ends up in a thrown Error.
        said = redactStderr(`${said}${text}`);
      },
      timeoutMs: REFRESH_TIMEOUT_MS,
    });
    void stream.stdout.cancel().catch(() => {});
    const timer = setTimeout(() => stream.close(), REFRESH_TIMEOUT_MS);
    let close: ExecClose;
    try {
      close = await stream.closed;
    } finally {
      clearTimeout(timer);
    }
    // No status means nobody saw the exit; the workspace may not have moved.
    if (close.status?.status !== 'Success') {
      throw new Error(
        `git said ${said.trim() || close.status?.message || close.reason}`,
      );
    }
    log.info('refreshed an adopted workspace', { sandbox: name, pod });
  }

  private async spares(): Promise<Sandbox[]> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: { labelSelector: this.spareSelector() },
    });
    return list.items.filter((spare) => !spare.metadata.deletionTimestamp);
  }

  private async sweep(): Promise<void> {
    const { config, log } = this.deps;
    const want = config.spares;
    // Pool off, the default: no apiserver calls at all.
    if (want === 0) return;
    if (this.inherited) await this.discard();
    const ready: Sandbox[] = [];
    // Unready spares that could not be condemned still take room on the node,
    // so they count against the pool.
    let stuck = 0;
    for (const spare of await this.spares()) {
      if (isReady(spare)) {
        ready.push(spare);
        continue;
      }
      // It was Ready once (`mintSpare` waits for that), so its pod was lost.
      // Renewing it would keep an unusable spare in the pool indefinitely.
      const name = spare.metadata.name;
      try {
        await this.condemn(name, spare.metadata.resourceVersion);
        log.info('condemned a spare that stopped being ready', {
          sandbox: name,
        });
      } catch (error) {
        // 409: a thread claimed it or the controller reaped it since the list.
        if (error instanceof KubeError && error.status === 409) continue;
        stuck += 1;
        log.warn('could not condemn a spare that stopped being ready', {
          sandbox: name,
          error: plain(error),
        });
      }
    }
    // Renew only `want`; any excess expires on its own short `shutdownTime`.
    for (const spare of ready.slice(0, want)) {
      try {
        await this.patch(spare.metadata.name, {
          metadata: { resourceVersion: spare.metadata.resourceVersion },
          spec: { shutdownTime: this.spareShutdownTime() },
        });
      } catch (error) {
        // 409: taken or reaped since the list, and neither wants a spare's
        // TTL back.
        if (error instanceof KubeError && error.status === 409) continue;
        log.warn('could not renew a spare', {
          sandbox: spare.metadata.name,
          error: plain(error),
        });
      }
    }
    let warm = ready.length;
    for (let short = want - ready.length - stuck; short > 0; short -= 1) {
      try {
        await this.mintSpare();
        warm += 1;
      } catch (error) {
        // Stop at the first refusal; the next sweep retries.
        log.warn('warming a spare failed', { error: plain(error) });
        break;
      }
    }
    // Counts only spares a thread could adopt now; a pool that stopped
    // refilling otherwise looks healthy, since threads still get answers.
    this.deps.metrics?.spares(warm, want);
  }

  /**
   * Spares outlive a rollout, and nothing on one records the image, model or
   * checkout it was built from, so the first pass discards them all.
   */
  private async discard(): Promise<void> {
    let all = true;
    for (const stale of await this.spares()) {
      const name = stale.metadata.name;
      try {
        await this.condemn(name);
        this.deps.log.info('discarded a spare left by an earlier mate', {
          sandbox: name,
        });
      } catch (error) {
        all = false;
        this.deps.log.warn('could not discard an inherited spare', {
          sandbox: name,
          error: plain(error),
        });
      }
    }
    // Retry while any remain, or an inherited spare is renewed indefinitely.
    this.inherited = !all;
  }

  private async mintSpare(): Promise<void> {
    const { kube, log } = this.deps;
    const name = spareName();
    const response = await kube.request(this.path(), {
      method: 'POST',
      body: sandboxManifest({
        name,
        namespace: this.namespace,
        labels: spareLabels(this.deps.guildId),
        config: this.deps.config,
        shutdownTime: this.spareShutdownTime(),
      }),
    });
    if (!ok(response)) throw await kubeError(response);
    await drain(response);
    await this.waitUsable(name);
    log.info('a spare is warm', { sandbox: name });
  }

  private async destroy(name: string): Promise<void> {
    const { kube } = this.deps;
    this.detach(name);
    const response = await kube.request(this.path(name), { method: 'DELETE' });
    if (!ok(response, 404)) throw await kubeError(response);
    await drain(response);
    await waitUntilGone(
      kube,
      this.path(),
      name,
      this.deps.goneTimeoutMs ?? GONE_TIMEOUT_MS,
    );
  }

  private async waitReady(name: string): Promise<Sandbox> {
    const { kube } = this.deps;
    const deadline =
      Date.now() + (this.deps.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const query = { fieldSelector: `metadata.name=${name}` };
    let why = 'nothing reported';
    for (;;) {
      const list = await kube.json<KubeList<Sandbox>>(this.path(), { query });
      const found = list.items[0];
      if (found) {
        if (isReady(found)) return found;
        why = whyNotReady(found);
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      const events = kube.watch<Sandbox>(
        this.path(),
        { ...query, resourceVersion: list.metadata.resourceVersion ?? '' },
        Math.min(WATCH_SECONDS, Math.ceil(left / 1000)),
      );
      let saw = false;
      for await (const event of events) {
        saw = true;
        if (event.type === 'DELETED') {
          throw new Error(`sandbox ${name} was deleted before it was ready`);
        }
        if (event.type !== 'ADDED' && event.type !== 'MODIFIED') continue;
        if (isReady(event.object)) return event.object;
        why = whyNotReady(event.object);
      }
      if (!saw) await idle(deadline);
    }
    throw new Error(`sandbox ${name} was not ready in time: ${why}`);
  }

  private async openSession(
    client: AcpClient,
    name: string,
    stored: string | undefined,
  ): Promise<{ id: string; resumed: boolean }> {
    const { log } = this.deps;
    if (stored) {
      try {
        await client.loadSession(stored, WORKSPACE);
        log.info('acp session loaded', { sandbox: name, session: stored });
        return { id: stored, resumed: true };
      } catch (error) {
        log.warn('acp session/load failed; opening a new session', {
          sandbox: name,
          session: stored,
          error: plain(error),
        });
      }
    }
    const fresh = await client.newSession(WORKSPACE);
    log.info('acp session opened', { sandbox: name, session: fresh });
    return { id: fresh, resumed: false };
  }

  // A dead mate's harness keeps running with no reader, and two `opencode acp`
  // processes would share one state directory.
  private async reap(name: string, pod: string): Promise<void> {
    const { kube, log } = this.deps;
    try {
      const stream = await kube.exec({
        namespace: this.namespace,
        pod,
        container: HARNESS_CONTAINER,
        // `-x` matches the process name; `-f` would match this shell's own
        // arguments and kill the reaper.
        command: ['/bin/sh', '-c', 'pkill -x opencode; exit 0'],
        timeoutMs: REAP_TIMEOUT_MS,
      });
      void stream.stdout.cancel().catch(() => {});
      const timer = setTimeout(() => stream.close(), REAP_TIMEOUT_MS);
      try {
        await stream.closed;
      } finally {
        clearTimeout(timer);
      }
      log.info('reaped any orphaned harness', { sandbox: name, pod });
    } catch (error) {
      log.warn('reaping the orphaned harness failed', {
        sandbox: name,
        pod,
        error: plain(error),
      });
    }
  }

  private detach(name: string): void {
    const attachment = this.attached.get(name);
    if (!attachment) return;
    this.attached.delete(name);
    attachment.client.close();
  }

  private async slide(name: string): Promise<void> {
    await this.patch(name, {
      spec: { shutdownTime: this.shutdownTime() },
      metadata: { annotations: { [TURN_ANNOTATION]: null } },
    });
  }

  // The controller deletes at `shutdownTime` even mid-turn, so the start of a
  // turn slides it too and the turn gets a full TTL.
  private async mark(name: string): Promise<void> {
    await this.patch(name, {
      spec: { shutdownTime: this.shutdownTime() },
      metadata: {
        annotations: { [TURN_ANNOTATION]: new Date().toISOString() },
      },
    });
  }

  private async remember(name: string, sessionId: string): Promise<void> {
    await this.patch(name, {
      metadata: { annotations: { [SESSION_ANNOTATION]: sessionId } },
    });
  }

  private async patch(name: string, body: unknown): Promise<void> {
    const response = await this.deps.kube.request(this.path(name), {
      method: 'PATCH',
      body,
      contentType: MERGE_PATCH,
    });
    if (!response.ok) throw await kubeError(response);
    await drain(response);
  }
}

function idle(deadline: number): Promise<void> {
  const left = Math.min(WATCH_IDLE_MS, deadline - Date.now());
  if (left <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, left));
}

function redactStderr(text: string): string {
  return text
    .replace(SECRET_SHAPED, '[redacted]')
    .trim()
    .slice(0, STDERR_LIMIT);
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}
