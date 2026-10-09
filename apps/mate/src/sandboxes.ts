/**
 * The sandboxes behind the brain's hands: one `agents.x-k8s.io/v1beta1`
 * Sandbox per thread, found by label, adopted from a warm spare or minted on
 * a turn's first tool call, and reached through mate-hands. Every turn slides
 * `spec.shutdownTime`, so a mate that dies mid-thread cannot leak one.
 */
import { PROTOCOL_VERSION } from '@repo/mate-hands/protocol';
import { type Clock, systemClock } from './clock.ts';
import type {
  KthxConfig,
  SandboxConfig,
  SwitchboardConfig,
  VaultConfig,
} from './config.ts';
import {
  Credentials,
  KUBECONFIG_PATH,
  kubeAccount,
  TOKEN_PATH,
} from './credentials.ts';
import { HARNESS_CONTAINER } from './hands.ts';
import {
  type Epochs,
  HandsLink,
  type HandsTarget,
  SandboxGone,
} from './hands-env.ts';
import {
  type ExecClose,
  type Kube,
  KubeError,
  type KubeList,
  type KubeObject,
  kubeError,
  ok,
} from './kube.ts';
import {
  AGENT_HOME,
  HANDS_LABEL,
  type Hands,
  type KubeHandsDeps,
  type OnMintStep,
  type SandboxSource,
  START_BUDGET_MS,
  type TeardownReason,
  type ThreadHands,
  type ThreadHandsHooks,
  TTL_MS,
  WORKSPACE,
} from './lease.ts';
import { plain } from './log.ts';
import {
  DEFAULT_PROFILE,
  laneOf,
  type Network,
  PROFILE_LABEL,
  PROFILES,
  type Profile,
} from './profiles.ts';
import { redact } from './redact.ts';
import {
  type LeaseDeps,
  type SandboxHandle,
  SandboxSlots,
  ThreadHandsImpl,
} from './sandbox-lease.ts';
import { type SurfaceName, type ThreadRef, threadKey } from './surface.ts';

export const SANDBOX_API = 'agents.x-k8s.io/v1beta1';
const SANDBOXES = '/apis/agents.x-k8s.io/v1beta1';
const PODS = '/api/v1';
const CEPS = '/apis/cilium.io/v2';

export const MINTED_BY = 'mate';
/** `MINTED_BY_LABEL` on a reader-network sandbox, which an image from before profiles never lists. */
export const MINTED_BY_READER = 'mate-reader';
export const MINTED_BY_LABEL = 'lolwtf.ca/minted-by';
/**
 * On a reader-network sandbox and its pod: `open` while the checkout clones,
 * the only time its network policy admits github.com, and `closed` before
 * the agent's first command.
 */
export const CHECKOUT_LABEL = 'lolwtf.ca/checkout';
const READER_NETWORK: Network = 'mate-sandbox-reader';
export const THREAD_LABEL = 'lolwtf.ca/thread';
export const CHANNEL_LABEL = 'lolwtf.ca/channel';
export const SURFACE_LABEL = 'lolwtf.ca/surface';
// Each mate serves one Discord guild, so its id names the owning mate for
// Slack threads too, and two mates in one namespace never list each other's
// sandboxes.
export const GUILD_LABEL = 'lolwtf.ca/guild';
// `true` on an unclaimed spare; adoption swaps it for the thread labels.
// `condemned` marks one being deleted; nothing takes it.
export const SPARE_LABEL = 'lolwtf.ca/spare';
const SPARE = 'true';
const CONDEMNED = 'condemned';
// The mate-hands protocol this code speaks. A sandbox without it was minted
// by an earlier mate, and the first boot condemns it.
const HANDS = String(PROTOCOL_VERSION);
// An earlier mate set this for the length of a turn; the first boot after it
// reads it to tell the thread its turn was cut off.
export const TURN_ANNOTATION = 'lolwtf.ca/turn-started';

export const CHECKOUT_CONTAINER = 'checkout';
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
const TOKEN_FILE = `${AGENT_HOME}/${TOKEN_PATH}`;
const KUBECONFIG_FILE = `${AGENT_HOME}/${KUBECONFIG_PATH}`;
// git asks every matching helper in config order and the first answer wins.
// `gitEnv` sets it empty first, which clears earlier helpers for this URL.
const CREDENTIAL_KEY = 'credential.https://github.com.helper';
// Answers `get` only; git also calls a helper to store and erase. An empty
// file exits 1, since git would report a blank password as a rejected one.
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; t=$(cat "$${TOKEN_FILE_ENV}" 2>/dev/null) || exit 1; test -n "$t" || exit 1; printf "username=${GIT_HTTPS_USER}\\npassword=%s\\n" "$t"; }; f`;

// Only a sweep renews a spare, so this bounds what a dead mate leaves on the
// node. Six sweeps fit, so a few failed sweeps cannot reap a healthy spare.
export const SPARE_TTL_MS = 30 * 60_000;
export const SPARE_SWEEP_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 300_000;
// How long Cilium may take to see a closed checkout window.
const CHECKOUT_CLOSE_MS = 30_000;
const CHECKOUT_POLL_MS = 1_000;
const REFRESH_TIMEOUT_MS = 60_000;
const GONE_TIMEOUT_MS = 180_000;
const WATCH_SECONDS = 60;
// Without a pause, a watch that ends with no event re-lists as fast as the
// apiserver answers.
const WATCH_IDLE_MS = 1_000;
const STDERR_LIMIT = 500;
// CRDs reject strategic merge; a merge patch leaves sibling fields alone.
const MERGE_PATCH = 'application/merge-patch+json';

/** `labelled`: the pod says `closed`, and its Cilium endpoint does not yet. */
type CheckoutState = 'open' | 'labelled' | 'closed';

/** A reader sandbox's window did not close; `wasClosed` when its pod said `closed` before the attempt. */
class CheckoutNotClosed extends Error {
  constructor(
    name: string,
    readonly wasClosed: boolean,
    cause: unknown,
  ) {
    super(
      `sandbox ${name} could not close its checkout window${cause ? `: ${plain(cause)}` : ''}`,
    );
  }
}

/** A throttled or failing apiserver, or no answer at all, may answer the next read. */
function passing(error: unknown): boolean {
  return (
    !(error instanceof KubeError) || error.status === 429 || error.status >= 500
  );
}

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

/**
 * `sandboxName(thread)`, plus `-r` on the reader network. An image from
 * before profiles reuses a sandbox of its own name that names the thread, so
 * it must never find a reader sandbox under that name.
 */
export function sandboxNameFor(thread: ThreadRef, profile: Profile): string {
  const name = sandboxName(thread);
  return profile.sandbox.network === READER_NETWORK ? `${name}-r` : name;
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

// The CLI's claiming host. The engine's MCP server is mate's to call, and its
// agent token stays in mate's pod.
function kthxEnv(kthx: KthxConfig): Record<string, unknown>[] {
  return kthx.origin ? [{ name: 'KTHX_ORIGIN', value: kthx.origin }] : [];
}

// A missing Secret would hold every sandbox in CreateContainerConfigError, so
// the token is optional; without it a ring gets a 401, which the skill reports.
function switchboardEnv(
  switchboard: SwitchboardConfig,
): Record<string, unknown>[] {
  return [
    { name: 'SWITCHBOARD_URL', value: switchboard.url },
    {
      name: 'SWITCHBOARD_RING_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: switchboard.secret,
          key: 'SWITCHBOARD_RING_TOKEN',
          optional: true,
        },
      },
    },
  ];
}

export interface SandboxDeclaration {
  name: string;
  namespace: string;
  /** Applied to both the object and its pod template. */
  labels: Record<string, string>;
  config: SandboxConfig;
  image: string;
  shutdownTime: string;
  /** Its grants decide what the pod's env holds. */
  profile: Profile;
}

function defaultProfile(): Profile {
  return PROFILES.get(DEFAULT_PROFILE) as Profile;
}

/** The profile a sandbox was minted for; `undefined` for one this code does not declare. */
function profileOfSandbox(sandbox: Sandbox): Profile | undefined {
  return PROFILES.get(
    sandbox.metadata.labels?.[PROFILE_LABEL] ?? DEFAULT_PROFILE,
  );
}

function baseLabels(guildId: string, profile: Profile): Record<string, string> {
  const reader = profile.sandbox.network === READER_NETWORK;
  return {
    // A CiliumNetworkPolicy selects each network name; `mate-sandbox-baseline`
    // default-denies a sandbox whose own policy is missing.
    'app.kubernetes.io/name': profile.sandbox.network,
    'app.kubernetes.io/part-of': 'mate',
    // An image from before profiles lists `minted-by=mate` only, so it never
    // sees a reader sandbox.
    [MINTED_BY_LABEL]: reader ? MINTED_BY_READER : MINTED_BY,
    [GUILD_LABEL]: guildId,
    [HANDS_LABEL]: HANDS,
    [PROFILE_LABEL]: profile.id,
    ...(reader ? { [CHECKOUT_LABEL]: 'open' } : {}),
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
  profile: Profile,
): Record<string, string> {
  return { ...baseLabels(guildId, profile), ...threadLabels(thread) };
}

// Minted for the default profile; only a profile with its pod adopts one.
function spareLabels(guildId: string): Record<string, string> {
  return { ...baseLabels(guildId, defaultProfile()), [SPARE_LABEL]: SPARE };
}

// In a merge patch, null removes a label.
function claimLabels(
  thread: ThreadRef,
  profile: Profile,
): Record<string, string | null> {
  return {
    ...threadLabels(thread),
    [PROFILE_LABEL]: profile.id,
    [SPARE_LABEL]: null,
  };
}

function condemnLabels(): Record<string, string | null> {
  return {
    [SURFACE_LABEL]: null,
    [THREAD_LABEL]: null,
    [CHANNEL_LABEL]: null,
    [SPARE_LABEL]: CONDEMNED,
  };
}

/** The thread a sandbox's labels name, if they name one. */
function threadOf(labels: Record<string, string>): ThreadRef | null {
  const id = labels[THREAD_LABEL];
  const channelId = labels[CHANNEL_LABEL];
  if (!id || !channelId || labels[SPARE_LABEL]) return null;
  // Discord sandboxes can predate the surface label.
  const surface = (labels[SURFACE_LABEL] ?? 'discord') as SurfaceName;
  return { surface, channelId, id };
}

/** The image a sandbox's harness runs, from its pod template. */
function harnessImage(sandbox: Sandbox): string | undefined {
  const template = sandbox.spec?.podTemplate as
    | { spec?: { containers?: { name?: string; image?: string }[] } }
    | undefined;
  return template?.spec?.containers?.find((c) => c.name === HARNESS_CONTAINER)
    ?.image;
}

function templateLabels(sandbox: Sandbox): Record<string, string> {
  const template = sandbox.spec?.podTemplate as
    | { metadata?: { labels?: Record<string, string> } }
    | undefined;
  return template?.metadata?.labels ?? {};
}

/** Checked, not selected on: older Discord sandboxes carry only the thread label. */
function belongsTo(sandbox: Sandbox, thread: ThreadRef): boolean {
  const labels = sandbox.metadata.labels ?? {};
  return (
    labels[THREAD_LABEL] === thread.id &&
    (labels[SURFACE_LABEL] ?? 'discord') === thread.surface &&
    (labels[CHANNEL_LABEL] ?? thread.channelId) === thread.channelId
  );
}

export function sandboxManifest(declaration: SandboxDeclaration): Sandbox {
  const { name, namespace, labels, config, image, shutdownTime, profile } =
    declaration;
  const { grants } = profile;
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
              image,
              imagePullPolicy: pullPolicy(image),
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
              image,
              imagePullPolicy: pullPolicy(image),
              env: [
                ...(config.vault && grants.vault
                  ? connectEnv(config.vault)
                  : []),
                ...(grants.kthxSites ? kthxEnv(config.kthx) : []),
                ...(config.switchboard && grants.switchboard
                  ? switchboardEnv(config.switchboard)
                  : []),
                ...gitEnv(config.github && grants.github),
                ...(kubeAccount(config, grants.kube)
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

/** The sandbox's running pod, or `null` when it has none. */
async function runningPod(
  kube: Kube,
  namespace: string,
  sandbox: Sandbox,
): Promise<Pod | null> {
  const selector = sandbox.status?.selector;
  if (!selector) return null;
  const pods = await kube.json<KubeList<Pod>>(
    `${PODS}/namespaces/${namespace}/pods`,
    { query: { labelSelector: selector } },
  );
  const uid = sandbox.metadata.uid;
  return (
    pods.items.find(
      (candidate) =>
        !candidate.metadata.deletionTimestamp &&
        candidate.status?.phase === 'Running' &&
        (!uid ||
          (candidate.metadata.ownerReferences ?? []).some(
            (o) => o.uid === uid,
          )),
    ) ?? null
  );
}

// Via `status.selector`: the controller does not set the
// `agents.x-k8s.io/pod-name` annotation.
export async function resolvePod(
  kube: Kube,
  namespace: string,
  sandbox: Sandbox,
): Promise<string> {
  const name = sandbox.metadata.name;
  const pod = await runningPod(kube, namespace, sandbox);
  if (!pod) {
    throw new Error(
      `sandbox ${name} has no running pod for ${sandbox.status?.selector ?? 'its selector'}`,
    );
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

/** Where a sandbox keeps the checkout and the agent's home; tests move both. */
export interface HandsLayout {
  readonly workspace: string;
  readonly home: string;
  /** Refuses a daemon with another home; `null` skips the check. */
  readonly expectHome: string | null;
  readonly epochs?: Epochs;
  /** How long, and how often, to wait for a closed checkout window. */
  readonly checkout?: { readonly closeMs: number; readonly pollMs: number };
}

const SANDBOX_LAYOUT: HandsLayout = {
  workspace: WORKSPACE,
  home: AGENT_HOME,
  expectHome: AGENT_HOME,
};

/**
 * The sandboxes of one guild's threads, the warm pool, and each thread's
 * hands. It holds one `ThreadHands` per open thread and caps the sandboxes
 * leased at once at `MATE_MAX_SANDBOXES`.
 */
export class KubeHands implements Hands {
  private readonly threads = new Map<string, ThreadHandsImpl>();
  // Labelled thread sandboxes counted at boot, before their threads open.
  private readonly standing = new Map<
    string,
    { ref: ThreadRef; name: string; profile: string }
  >();
  private readonly slots: SandboxSlots;
  private readonly credentials: Credentials;
  private readonly clock: Clock;
  private readonly leaseDeps: LeaseDeps;
  private warming: Promise<void> | null = null;
  private again = false;
  // Spares outlive a rollout, and nothing on one records the checkout it was
  // built from, so the first pass discards them all.
  private inheritedSpares = true;
  private inheritedSandboxes = false;

  constructor(
    private readonly deps: KubeHandsDeps,
    private readonly layout: HandsLayout = SANDBOX_LAYOUT,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.slots = new SandboxSlots({
      capacity: deps.maxSandboxes,
      clock: this.clock,
      log: deps.log,
      metrics: deps.metrics,
      evict: (key, wanted) => this.evict(key, wanted),
    });
    this.credentials = new Credentials({
      kube: deps.kube,
      namespace: this.namespace,
      config: deps.config,
      log: deps.log,
      clock: this.clock,
      metrics: deps.metrics,
      githubApp: deps.githubApp,
      kthxSites: deps.kthxSites,
      clusterCa: deps.clusterCa,
      sshKey: deps.sshKey,
      talosconfig: deps.talosconfig,
      home: layout.home,
    });
    this.leaseDeps = {
      log: deps.log,
      clock: this.clock,
      metrics: deps.metrics,
      slots: this.slots,
      credentials: this.credentials,
      workspace: layout.workspace,
      home: layout.home,
      acquire: (ref, profile, onStep) => this.acquire(ref, profile, onStep),
      find: (ref, profile) => this.findReady(ref, profile),
      link: (handle) => this.link(handle),
      slide: (name) => this.slide(name),
      lose: (name) => this.lose(name),
      discard: (name) => this.discardOne(name),
    };
  }

  get namespace(): string {
    return this.deps.config.namespace ?? this.deps.kube.namespace;
  }

  thread(
    ref: ThreadRef,
    hooks: ThreadHandsHooks,
    profile: Profile,
  ): ThreadHands {
    const key = threadKey(ref);
    const known = this.threads.get(key);
    if (known) {
      if (known.profile.id !== profile.id) {
        throw new Error(
          `thread ${key} is held under profile ${known.profile.id}, not ${profile.id}`,
        );
      }
      known.hooks = hooks;
      return known;
    }
    const standing = this.standing.get(key);
    const made = new ThreadHandsImpl(
      ref,
      key,
      hooks,
      this.leaseDeps,
      profile,
      // Another profile's sandbox is condemned on the first acquire.
      standing?.profile === profile.id ? standing.name : null,
    );
    this.threads.set(key, made);
    return made;
  }

  async release(ref: ThreadRef, reason: TeardownReason): Promise<void> {
    const { log, metrics } = this.deps;
    const key = threadKey(ref);
    const thread = this.threads.get(key);
    if (thread) thread.released = true;
    try {
      await thread?.openLease?.abandon();
      const found = await this.sandboxesOf(ref);
      for (const sandbox of found) {
        const name = sandbox.metadata.name;
        await this.keepSites(sandbox);
        await this.destroy(name);
        this.credentials.forget(name);
      }
      const held = found.length > 0 || Boolean(thread?.holding);
      this.slots.release(key);
      this.standing.delete(key);
      this.threads.delete(key);
      if (!held) return;
      thread?.tell((hooks) => hooks.onSandboxGone(reason));
      metrics?.teardown(reason);
    } catch (error) {
      if (thread) thread.released = false;
      log.warn("could not release the thread's sandbox", {
        thread: key,
        reason,
        error: plain(error),
      });
    }
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

  async start(): Promise<readonly ThreadRef[]> {
    const { log } = this.deps;
    let listed: Sandbox[];
    try {
      listed = await this.listWithin(START_BUDGET_MS);
    } catch (error) {
      log.warn('could not count the standing sandboxes at boot', {
        error: plain(error),
      });
      this.inheritedSandboxes = true;
      return [];
    }
    const interrupted: ThreadRef[] = [];
    const inherited: Sandbox[] = [];
    for (const sandbox of listed) {
      const labels = sandbox.metadata.labels ?? {};
      const thread = threadOf(labels);
      if (labels[HANDS_LABEL] === HANDS) {
        if (!thread) continue;
        const key = threadKey(thread);
        this.standing.set(key, {
          ref: thread,
          name: sandbox.metadata.name,
          profile: labels[PROFILE_LABEL] ?? DEFAULT_PROFILE,
        });
        this.slots.register(
          key,
          laneOf(profileOfSandbox(sandbox) ?? defaultProfile()),
        );
        continue;
      }
      if (labels[SPARE_LABEL] === CONDEMNED) continue;
      if (thread && sandbox.metadata.annotations?.[TURN_ANNOTATION]) {
        interrupted.push(thread);
      }
      inherited.push(sandbox);
    }
    if (inherited.length > 0) {
      this.inheritedSandboxes = true;
      void this.condemnInherited(inherited);
    }
    return interrupted;
  }

  /** Each lease's `abandon` is bounded by `ABANDON_BUDGET_MS`, and they run together. */
  async shutdown(): Promise<void> {
    const leases = [...this.threads.values()].flatMap((thread) =>
      thread.openLease ? [thread.openLease] : [],
    );
    await Promise.all(leases.map((lease) => lease.abandon()));
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

  private async sweep(): Promise<void> {
    const { config, log } = this.deps;
    if (this.inheritedSandboxes) {
      const listed = await this.list().catch((error: unknown) => {
        log.warn('could not list sandboxes an earlier mate left', {
          error: plain(error),
        });
        return null;
      });
      if (listed) {
        await this.condemnInherited(
          listed.filter(
            (s) =>
              s.metadata.labels?.[HANDS_LABEL] !== HANDS &&
              s.metadata.labels?.[SPARE_LABEL] !== CONDEMNED,
          ),
        );
      }
    }
    const want = config.spares;
    // Pool off, the default: no apiserver calls at all.
    if (want === 0) return;
    if (this.inheritedSpares) await this.discardSpares();
    const image = await this.deps.image();
    const ready: Sandbox[] = [];
    // Spares that could not be condemned still take room on the node, so they
    // count against the pool.
    let stuck = 0;
    for (const spare of await this.spares()) {
      const current = harnessImage(spare) === image;
      if (isReady(spare) && current) {
        ready.push(spare);
        continue;
      }
      // Not ready, it was Ready once (`mintSpare` waits for that), so its pod
      // was lost. Renewing either kind would keep it in the pool indefinitely.
      const why = current ? 'stopped being ready' : 'runs an older image';
      const name = spare.metadata.name;
      try {
        await this.condemn(name, spare.metadata.resourceVersion);
        log.info(`condemned a spare that ${why}`, { sandbox: name });
      } catch (error) {
        // 409: a thread claimed it or the controller reaped it since the list.
        if (error instanceof KubeError && error.status === 409) continue;
        stuck += 1;
        log.warn(`could not condemn a spare that ${why}`, {
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
   * Sandboxes an earlier mate minted, which speak no protocol this one does:
   * a thread's keeps its kthx sites first. Retried each sweep until all go.
   */
  private async condemnInherited(sandboxes: Sandbox[]): Promise<void> {
    const { log, metrics } = this.deps;
    let all = true;
    for (const sandbox of sandboxes) {
      const name = sandbox.metadata.name;
      const claimed = threadOf(sandbox.metadata.labels ?? {}) !== null;
      try {
        if (claimed) await this.keepSites(sandbox);
        await this.condemn(name);
        this.credentials.forget(name);
        if (claimed) metrics?.teardown('inherited');
        log.info('condemned a sandbox an earlier mate left', {
          sandbox: name,
        });
      } catch (error) {
        all = false;
        log.warn('could not condemn a sandbox an earlier mate left', {
          sandbox: name,
          error: plain(error),
        });
      }
    }
    if (all) this.inheritedSandboxes = false;
  }

  /** Finds, adopts or mints the thread's sandbox, and waits for it to be Ready. */
  private async acquire(
    ref: ThreadRef,
    profile: Profile,
    onStep: OnMintStep,
  ): Promise<SandboxHandle> {
    const existing = await this.find(ref, profile);
    if (existing) {
      const reused = await this.reuse(existing, onStep);
      return this.handle(ref, reused, 'reused', profile);
    }
    const adopted = profile.sandbox.spares
      ? await this.adopt(ref, profile, onStep)
      : null;
    if (adopted) {
      // Refill in the background: this thread should not wait for it.
      void this.ensureSpares().catch((error) =>
        this.deps.log.warn('minting a replacement spare failed', {
          error: plain(error),
        }),
      );
      return this.handle(ref, adopted, 'spare', profile);
    }
    const minted = await this.mintFresh(ref, profile, onStep);
    return this.handle(ref, minted.sandbox, minted.source, profile);
  }

  private async handle(
    ref: ThreadRef,
    sandbox: Sandbox,
    source: SandboxSource,
    profile: Profile,
  ): Promise<SandboxHandle> {
    if (profile.sandbox.network === READER_NETWORK) {
      try {
        await this.closeCheckout(sandbox);
      } catch (error) {
        // A window closed before this call stays closed, and the next
        // acquire checks it again; only one left open is deleted.
        if (error instanceof CheckoutNotClosed && error.wasClosed) throw error;
        const name = sandbox.metadata.name;
        await this.destroy(name).catch((failure) =>
          this.deps.log.warn('could not delete a sandbox left open', {
            sandbox: name,
            error: plain(failure),
          }),
        );
        this.credentials.forget(name);
        const thread = this.threads.get(threadKey(ref));
        if (thread?.holding === name) {
          thread.gone(name);
          thread.tell((hooks) => hooks.onSandboxGone('lost'));
        }
        throw error;
      }
    }
    const pod = await runningPod(this.deps.kube, this.namespace, sandbox);
    if (!pod) {
      throw new Error(`sandbox ${sandbox.metadata.name} has no running pod`);
    }
    return {
      sandbox: sandbox.metadata.name,
      pod: pod.metadata.name,
      podUid: pod.metadata.uid ?? null,
      source,
    };
  }

  /** The thread's sandbox if it stands Ready; never mints. */
  private async findReady(
    ref: ThreadRef,
    profile: Profile,
  ): Promise<SandboxHandle | null> {
    const found = await this.find(ref, profile);
    if (!found || !isReady(found)) return null;
    return this.handle(ref, found, 'reused', profile);
  }

  /**
   * Before the agent's first command on the reader network: labels the pod
   * `checkout=closed`, then waits until Cilium's endpoint carries the label,
   * so the clone's egress is gone. A read the apiserver may answer later is
   * tried again until the deadline. Throws when either never happens.
   */
  private async closeCheckout(sandbox: Sandbox): Promise<void> {
    const name = sandbox.metadata.name;
    const { closeMs, pollMs } = this.layout.checkout ?? {
      closeMs: CHECKOUT_CLOSE_MS,
      pollMs: CHECKOUT_POLL_MS,
    };
    const deadline = Date.now() + closeMs;
    // Whether the pod said `closed` before this call: null until a read answers.
    let wasClosed: boolean | null = null;
    let patched = false;
    let last: unknown = null;
    for (;;) {
      let state: CheckoutState | null = null;
      try {
        state = await this.checkoutState(sandbox);
      } catch (error) {
        if (!passing(error)) {
          throw new CheckoutNotClosed(name, wasClosed === true, error);
        }
        last = error;
      }
      if (state === 'closed') return;
      if (state) wasClosed ??= state === 'labelled';
      if (state === 'open' && !patched) {
        const labels = { [CHECKOUT_LABEL]: 'closed' };
        await this.patch(name, {
          metadata: { labels },
          spec: { podTemplate: { metadata: { labels } } },
        });
        patched = true;
      }
      if (Date.now() >= deadline) {
        throw new CheckoutNotClosed(name, wasClosed === true, last);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** The running pod's label, then whether its Cilium endpoint's identity carries it. */
  private async checkoutState(sandbox: Sandbox): Promise<CheckoutState> {
    const pod = await runningPod(this.deps.kube, this.namespace, sandbox);
    if (pod?.metadata.labels?.[CHECKOUT_LABEL] !== 'closed') return 'open';
    let endpoint: {
      status?: { state?: string; identity?: { labels?: string[] } };
    };
    try {
      endpoint = await this.deps.kube.json(
        `${CEPS}/namespaces/${this.namespace}/ciliumendpoints/${pod.metadata.name}`,
      );
    } catch (error) {
      // Cilium has not made the endpoint yet.
      if (error instanceof KubeError && error.status === 404) return 'labelled';
      throw error;
    }
    const closed =
      endpoint.status?.state === 'ready' &&
      (endpoint.status.identity?.labels ?? []).includes(
        `k8s:${CHECKOUT_LABEL}=closed`,
      );
    return closed ? 'closed' : 'labelled';
  }

  private link(handle: SandboxHandle): HandsLink {
    return new HandsLink({
      kube: this.deps.kube,
      namespace: this.namespace,
      log: this.deps.log,
      clock: this.clock,
      metrics: this.deps.metrics,
      cwd: this.layout.workspace,
      expectHome: this.layout.expectHome,
      epochs: this.layout.epochs,
      locate: () => this.locate(handle),
    });
  }

  /** Where `handle`'s daemon runs, while its pod is still the one it was. */
  private async locate(handle: SandboxHandle): Promise<HandsTarget> {
    const name = handle.sandbox;
    let sandbox: Sandbox;
    try {
      sandbox = await this.deps.kube.json<Sandbox>(this.path(name));
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) {
        throw new SandboxGone(`sandbox ${name} was deleted`);
      }
      throw error;
    }
    if (sandbox.metadata.deletionTimestamp) {
      throw new SandboxGone(`sandbox ${name} is being deleted`);
    }
    if (!isReady(sandbox)) {
      throw new SandboxGone(
        `sandbox ${name} stopped being ready: ${whyNotReady(sandbox)}`,
      );
    }
    const pod = await runningPod(this.deps.kube, this.namespace, sandbox);
    if (
      !pod ||
      pod.metadata.name !== handle.pod ||
      (handle.podUid !== null && pod.metadata.uid !== handle.podUid)
    ) {
      throw new SandboxGone(`sandbox ${name} lost its pod ${handle.pod}`);
    }
    if (
      sandbox.metadata.labels?.['app.kubernetes.io/name'] === READER_NETWORK &&
      pod.metadata.labels?.[CHECKOUT_LABEL] !== 'closed'
    ) {
      throw new SandboxGone(
        `sandbox ${name} still has its checkout window open`,
      );
    }
    return { sandbox: name, pod: handle.pod };
  }

  /** A sandbox that died or runs no daemon mate speaks to. Never throws. */
  private async lose(name: string): Promise<void> {
    try {
      const sandbox = await this.deps.kube
        .json<Sandbox>(this.path(name))
        .catch(() => null);
      if (sandbox) await this.keepSites(sandbox);
      await this.condemn(name);
    } catch (error) {
      if (error instanceof KubeError && error.status === 404) return;
      this.deps.log.warn('could not condemn a lost sandbox', {
        sandbox: name,
        error: plain(error),
      });
    } finally {
      this.credentials.forget(name);
    }
  }

  private async discardOne(name: string): Promise<void> {
    await this.condemn(name).catch((error: unknown) =>
      this.deps.log.warn('could not discard a sandbox nobody wants', {
        sandbox: name,
        error: plain(error),
      }),
    );
  }

  /**
   * Preempts an idle holder for a waiting thread; true once it no longer
   * counts. A turn that begins before the condemn keeps the sandbox, and one
   * that begins after it waits for its slot to be taken, then for another.
   */
  private async evict(key: string, wanted: () => boolean): Promise<boolean> {
    const { log, metrics } = this.deps;
    const inUse = () => {
      const thread = this.threads.get(key);
      return Boolean(thread?.openLease || thread?.busy);
    };
    const ref = this.threads.get(key)?.ref ?? this.standing.get(key)?.ref;
    if (!ref) return true;
    if (inUse() || !wanted()) return false;
    const found = await this.sandboxesOf(ref);
    for (const sandbox of found) await this.keepSites(sandbox);
    if (inUse() || !wanted()) return false;
    const thread = this.threads.get(key);
    for (const sandbox of found) {
      const name = sandbox.metadata.name;
      await this.condemn(name);
      this.credentials.forget(name);
      thread?.gone(name);
    }
    this.standing.delete(key);
    if (thread) thread.holding = null;
    if (found.length === 0) return true;
    log.info('preempted an idle sandbox for a waiting thread', {
      thread: key,
      sandboxes: found.map((s) => s.metadata.name),
    });
    thread?.tell((hooks) => hooks.onSandboxGone('preempted'));
    metrics?.teardown('preempted');
    return true;
  }

  /**
   * Best effort, before the delete takes the file with it. Only from a pod
   * whose profile label and network both say it held the sites file: any
   * other could have written one to overwrite the ledger.
   */
  private async keepSites(sandbox: Sandbox): Promise<void> {
    const profile = profileOfSandbox(sandbox);
    if (
      !this.credentials.kthx ||
      !profile?.grants.kthxSites ||
      sandbox.metadata.labels?.['app.kubernetes.io/name'] !==
        profile.sandbox.network
    ) {
      return;
    }
    const pod = await runningPod(this.deps.kube, this.namespace, sandbox).catch(
      () => null,
    );
    if (pod) {
      await this.credentials.keepSites(
        sandbox.metadata.name,
        pod.metadata.name,
      );
    }
  }

  private async list(): Promise<Sandbox[]> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: { labelSelector: this.selector() },
    });
    return list.items.filter((s) => !s.metadata.deletionTimestamp);
  }

  private listWithin(ms: number): Promise<Sandbox[]> {
    return new Promise((resolve, reject) => {
      const timer = this.clock.after(ms, () =>
        reject(new Error(`listing took over ${ms / 1000}s`)),
      );
      this.list().then(
        (listed) => {
          this.clock.cancel(timer);
          resolve(listed);
        },
        (error: unknown) => {
          this.clock.cancel(timer);
          reject(error);
        },
      );
    });
  }

  private path(name?: string): string {
    const base = `${SANDBOXES}/namespaces/${this.namespace}/sandboxes`;
    return name ? `${base}/${name}` : base;
  }

  private selector(): string {
    return `${MINTED_BY_LABEL} in (${MINTED_BY},${MINTED_BY_READER}),${GUILD_LABEL}=${this.deps.guildId}`;
  }

  private handsSelector(): string {
    return `${this.selector()},${HANDS_LABEL}=${HANDS}`;
  }

  private shutdownTime(): string {
    return new Date(Date.now() + (this.deps.ttlMs ?? TTL_MS)).toISOString();
  }

  private spareShutdownTime(): string {
    return new Date(Date.now() + SPARE_TTL_MS).toISOString();
  }

  private spareSelector(): string {
    return `${this.handsSelector()},${SPARE_LABEL}=${SPARE}`;
  }

  /**
   * By label, since an adopted spare's name derives from no thread. A
   * terminating object is skipped, because `reuse` fails on it. A sandbox
   * minted for another profile is never handed over: it keeps its sites, if
   * its own labels grant them, and is condemned.
   */
  private async find(
    thread: ThreadRef,
    profile: Profile,
  ): Promise<Sandbox | undefined> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: {
        labelSelector: `${this.handsSelector()},${THREAD_LABEL}=${thread.id}`,
      },
    });
    for (const found of list.items) {
      if (found.metadata.deletionTimestamp || !belongsTo(found, thread)) {
        continue;
      }
      const name = found.metadata.name;
      const labelled = found.metadata.labels?.[PROFILE_LABEL];
      if ((labelled ?? DEFAULT_PROFILE) !== profile.id) {
        this.deps.log.error(
          'a sandbox of this thread is labelled for another profile',
          { sandbox: name, profile: profile.id, labelled },
        );
        await this.keepSites(found);
        await this.condemn(name);
        this.credentials.forget(name);
        continue;
      }
      // A pod the controller made again after the window closed can never
      // clone, and would hold the turn until the Ready timeout.
      if (
        profile.sandbox.network === READER_NETWORK &&
        !isReady(found) &&
        templateLabels(found)[CHECKOUT_LABEL] === 'closed'
      ) {
        this.deps.log.info(
          'condemned a read-only sandbox whose pod cannot clone again',
          { sandbox: name },
        );
        await this.condemn(name);
        this.credentials.forget(name);
        continue;
      }
      return found;
    }
    return undefined;
  }

  /** Every sandbox labelled for the thread, whatever protocol it speaks. */
  private async sandboxesOf(thread: ThreadRef): Promise<Sandbox[]> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: {
        labelSelector: `${this.selector()},${THREAD_LABEL}=${thread.id}`,
      },
    });
    return list.items.filter(
      (found) => !found.metadata.deletionTimestamp && belongsTo(found, thread),
    );
  }

  /** A full TTL from now, so a long turn is not reaped mid-answer. */
  private async reuse(existing: Sandbox, onStep: OnMintStep): Promise<Sandbox> {
    const name = existing.metadata.name;
    if (existing.metadata.deletionTimestamp) {
      throw new Error(`sandbox ${name} is still terminating`);
    }
    this.deps.log.info('sandbox already existed', { sandbox: name });
    onStep('reusing');
    const ready = await this.waitUsable(name);
    await this.slide(name);
    return ready;
  }

  private async mintFresh(
    thread: ThreadRef,
    profile: Profile,
    onStep: OnMintStep,
  ): Promise<{ sandbox: Sandbox; source: SandboxSource }> {
    const { kube } = this.deps;
    const base = sandboxNameFor(thread, profile);
    const labels = sandboxLabels(thread, this.deps.guildId, profile);
    onStep('creating');
    let name = base;
    let response = await this.create(name, labels, profile);
    if (response.status === 409) {
      await drain(response);
      // `find` saw nothing of ours, so the name is held by a sandbox being
      // deleted, or one an earlier mate minted; this one gets its own.
      const holder = await kube.json<Sandbox>(this.path(name));
      if (
        !holder.metadata.deletionTimestamp &&
        holder.metadata.labels?.[HANDS_LABEL] === HANDS &&
        (holder.metadata.labels?.[PROFILE_LABEL] ?? DEFAULT_PROFILE) ===
          profile.id &&
        belongsTo(holder, thread)
      ) {
        return { sandbox: await this.reuse(holder, onStep), source: 'reused' };
      }
      name = `${base}-${crypto.randomUUID().slice(0, 4)}`;
      response = await this.create(name, labels, profile);
    }
    if (!ok(response)) throw await kubeError(response);
    await drain(response);
    onStep('booting');
    return { sandbox: await this.waitUsable(name), source: 'fresh' };
  }

  private async create(
    name: string,
    labels: Record<string, string>,
    profile: Profile,
    shutdownTime = this.shutdownTime(),
  ): Promise<Response> {
    return this.deps.kube.request(this.path(), {
      method: 'POST',
      body: sandboxManifest({
        name,
        namespace: this.namespace,
        labels,
        config: this.deps.config,
        image: await this.deps.image(),
        shutdownTime,
        profile,
      }),
    });
  }

  private async waitUsable(name: string): Promise<Sandbox> {
    try {
      return await this.waitReady(name);
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
    profile: Profile,
    onStep: OnMintStep,
  ): Promise<Sandbox | null> {
    const { config, log } = this.deps;
    // Pool off: skip the list, so an apiserver hiccup cannot cost a thread
    // its answer.
    if (config.spares === 0) return null;
    const labels = claimLabels(thread, profile);
    // A spare on an older image is the sweep's to condemn.
    const image = await this.deps.image();
    for (const spare of await this.spares()) {
      if (!isReady(spare) || harnessImage(spare) !== image) continue;
      const name = spare.metadata.name;
      onStep('adopting');
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
      onStep('refreshing');
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
      return spare;
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

  // Before the first tool call, so the agent never sees the spare's old tree.
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

  private async discardSpares(): Promise<void> {
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
    this.inheritedSpares = !all;
  }

  private async mintSpare(): Promise<void> {
    const name = spareName();
    const response = await this.create(
      name,
      spareLabels(this.deps.guildId),
      defaultProfile(),
      this.spareShutdownTime(),
    );
    if (!ok(response)) throw await kubeError(response);
    await drain(response);
    await this.waitUsable(name);
    this.deps.log.info('a spare is warm', { sandbox: name });
  }

  private async destroy(name: string): Promise<void> {
    const { kube } = this.deps;
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

  private async slide(name: string): Promise<void> {
    await this.patch(name, { spec: { shutdownTime: this.shutdownTime() } });
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
  return redact(text).trim().slice(0, STDERR_LIMIT);
}

async function drain(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}
