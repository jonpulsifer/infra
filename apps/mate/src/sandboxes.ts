/**
 * Sandboxes on the cluster: one bare `agents.x-k8s.io/v1beta1` Sandbox per
 * thread, the harness reached by exec-ing `opencode acp` in its pod,
 * and `spec.shutdownTime` slid forward at both ends of every turn so a mate
 * that dies mid-thread cannot leak one.
 */
import { AcpClient } from './acp.ts';
import type { SandboxConfig, VaultConfig } from './config.ts';
/**
 * What a turn needs of a GitHub App, which is less than the App is: mint one
 * and hand it back. Narrow on purpose — the private key, the installation
 * lookup and the preflight all live on the other side of it, so nothing here
 * can reach them and a test can stand in without one.
 */
export interface TokenSource {
  token(): Promise<{ token: string }>;
  revoke(token: string): Promise<void>;
}

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
/** Which surface the thread is on, so `list()` can hand it back to the right one. */
export const SURFACE_LABEL = 'lolwtf.ca/surface';
/**
 * This mate's own identity, so two mates sharing a namespace never list each
 * other's sandboxes. mate answers in exactly one Discord guild, so that id is
 * what says which mate a sandbox belongs to whichever surface minted it.
 */
export const GUILD_LABEL = 'lolwtf.ca/guild';
/**
 * On a sandbox nobody has claimed, and on nothing else. Swapping this one
 * label for a thread's three is the whole of adoption, which is why a spare
 * carries no thread labels at all rather than placeholder ones.
 *
 * `condemned` is the same marker on a sandbox mate has given up on and is
 * deleting. It is not `true`, so the pool cannot hand it to anybody; it is
 * not absent, so `list()` skips it with the spares rather than warning about
 * a stray; and the thread labels come off in the same patch, so a delete that
 * does not land leaves nothing that answers to a thread.
 */
export const SPARE_LABEL = 'lolwtf.ca/spare';
const SPARE = 'true';
const CONDEMNED = 'condemned';
/**
 * The harness's own session id, kept on the object rather than in a label:
 * mate stores whatever the harness minted, and a label value is restricted to
 * 63 characters of `[A-Za-z0-9._-]`.
 */
export const SESSION_ANNOTATION = 'lolwtf.ca/acp-session';
/**
 * Stamped when a turn starts and cleared when it ends, so a mate that died
 * under a running turn can say so in the thread instead of going quiet: this
 * annotation surviving on the object is the only evidence left.
 */
export const TURN_ANNOTATION = 'lolwtf.ca/turn-started';

export const HARNESS_CONTAINER = 'harness';
export const CHECKOUT_CONTAINER = 'checkout';
export const WORKSPACE = '/workspace';
export const AGENT_HOME = '/home/agent';
export const AGENT_UID = 1337;
/**
 * Who the agent commits as. The image's agent user is made with no GECOS and
 * the sandbox carries no git config of its own, so without an ident handed in
 * `git commit` dies on an empty ident name.
 */
const GIT_USER = 'clanky-bot[bot]';
/**
 * The id prefix is the bot user's own numeric id, and it is what makes GitHub
 * attribute a commit to the App's account and draw its avatar. The bare
 * `login@users.noreply.github.com` form commits fine and links to nobody.
 */
const GIT_EMAIL = '332275392+clanky-bot[bot]@users.noreply.github.com';
/**
 * The username half of an installation token, which GitHub fixes and which is
 * not the ident above. They were one string while the credential was a user's
 * PAT and the same name answered for both; an App's token authenticates as
 * `x-access-token` whatever the commits say, so conflating them again would
 * break the push and not the commit.
 */
const GIT_HTTPS_USER = 'x-access-token';
/**
 * How much history the checkout carries. One commit is enough to branch from
 * and enough to push from — both measured against a genuinely shallow clone —
 * so the depth is not what makes a pull request possible. It is what makes one
 * fit in: this repo's commit subjects are a house style, and an agent asked to
 * match them can only do that by reading them, which at depth 1 means reading
 * the single commit it is standing on. Thirty is the window a person gets from
 * `git log --oneline -30`; fifty leaves room above it, and measured 136 KiB
 * more than depth 1 on a 15 MB clone of this repo — inside the run-to-run
 * noise of the clone itself.
 */
const CHECKOUT_DEPTH = 50;
/**
 * Where mate writes the turn's GitHub token, and the variable naming it. The
 * helper below and `images/mate-sandbox/gh` both spell this name, so it is
 * one constant rather than three strings that can drift — and the agent's own
 * commands can read the file, which is how a call to `api.github.com` gets a
 * token. That it is readable is not a slip: the sandbox auto-allows every
 * command, so reach was never the property being bought. What is bought is
 * what the readable thing is worth — an hour, one repository, two
 * permissions, and handed back within seconds of the turn ending.
 */
const TOKEN_FILE_ENV = 'MATE_GITHUB_TOKEN_FILE';
const TOKEN_FILE = `${AGENT_HOME}/.github-token`;
/**
 * Scoped to the one URL rather than set as a bare `credential.helper`: git
 * tries every helper that matches, in the order the configs are read, and the
 * first answer wins. This one is the last read, so a generic helper — one the
 * agent sets itself, one a future base image ships — would answer for
 * github.com before it. Setting the key to an empty value first resets that
 * list for this URL only, which was measured both ways: with the reset the
 * helper below answers, without it the other one does, and a request for any
 * other host still reaches whatever else is configured.
 */
const CREDENTIAL_KEY = 'credential.https://github.com.helper';
/**
 * What git runs when a push to github.com needs a password: a read of the
 * file mate stamped at the start of the turn, printed in git's credential
 * format and never stored. There is no timeout on it and none is needed — a
 * local read cannot hang, which is the whole of what the previous `op read`
 * needed bounding for.
 *
 * The snippet is a constant with nothing interpolated into it, and git passes
 * a `GIT_CONFIG_VALUE_n` through verbatim, so there is no quoting layer
 * between here and the shell. An empty file fails rather than answering with
 * a blank password, because a blank password is how a rotation in progress
 * looks and git would report it as a rejected credential rather than as a
 * missing one. Only `get` is answered because git calls the same helper to
 * store and to erase, and there is nothing here to write to.
 */
const CREDENTIAL_HELPER = `!f() { test "$1" = get || exit 0; t=$(cat "$${TOKEN_FILE_ENV}" 2>/dev/null) || exit 1; test -n "$t" || exit 1; printf "username=${GIT_HTTPS_USER}\\npassword=%s\\n" "$t"; }; f`;

export const TTL_MS = 2 * 60 * 60_000;
/**
 * A spare's own TTL, far under `TTL_MS` because the two are what is left when
 * different things go wrong. Every turn slides a thread's sandbox, so its two
 * hours only ever run down on a thread nobody came back to; a spare is slid
 * by `ensureSpares` and by nothing else, so this is what a mate that died
 * between sweeps leaves sitting on the node — half an hour of the room one
 * sandbox takes, rather than a quarter of a day of it. Six sweeps fit inside
 * it, so a sweep that fails a few times running does not reap a healthy spare.
 *
 * This is the whole of why mate stopping hands its spares back, and the other
 * two places that turn on it say so in a clause and point here.
 */
export const SPARE_TTL_MS = 30 * 60_000;
export const SPARE_SWEEP_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 300_000;
const REFRESH_TIMEOUT_MS = 60_000;
/**
 * One `printf` into a file on a pod that is already answering ACP. Short
 * because a stamp that is not quick is a stamp that has gone wrong, and the
 * human is waiting on the turn behind it.
 */
const STAMP_TIMEOUT_MS = 15_000;
const GONE_TIMEOUT_MS = 180_000;
const REAP_TIMEOUT_MS = 15_000;
const WATCH_SECONDS = 60;
/** A watch that ends without an event — an expired revision, a proxy dropping
 * the stream — would otherwise re-list as fast as the apiserver answers. */
const WATCH_IDLE_MS = 1_000;
const STDERR_LIMIT = 500;
/**
 * `OPENCODE_API_KEY` is in the harness's environment, so a provider error that
 * echoes it would otherwise land verbatim in the bot's logs.
 */
const SECRET_SHAPED =
  /(?:sk-[A-Za-z0-9._-]{8,}|[Bb]earer\s+[A-Za-z0-9._-]{8,}|[A-Za-z0-9_-]{32,})/g;
/** CRDs carry no strategic-merge metadata, so a merge patch is the one that leaves sibling fields alone. */
const MERGE_PATCH = 'application/merge-patch+json';

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

export interface SandboxStatus {
  conditions?: Condition[];
  /** The label selector the controller stamps on the backing pod. */
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
  /**
   * Where the sweep reports the pool. Optional because the smoke harness
   * drives the same class with no SDK behind it; a mate serving threads is
   * wired with instruments in `main.ts`, and what they carry is the only view
   * of the pool from outside the pod.
   */
  metrics?: Instruments;
  /**
   * What mints the GitHub token a turn is stamped with, or absent where no
   * App is configured — which is both the rollback and what the smoke
   * harness runs with. It is a dependency rather than something built here
   * because the private key belongs to the process, never to a sandbox's
   * configuration.
   */
  githubApp?: TokenSource | null;
  ttlMs?: number;
  readyTimeoutMs?: number;
  goneTimeoutMs?: number;
}

interface Attachment {
  client: AcpClient;
  sessionId: string;
  /** Already resolved by `attach`, and what a turn's token is stamped into. */
  pod: string;
}

const SNOWFLAKE = /^\d{15,22}$/;
const SLACK_CHANNEL = /^[A-Z][A-Z0-9]{1,20}$/;
const SLACK_TS = /^\d{10}\.\d{6}$/;

/**
 * The Sandbox a thread gets, named after the thread. The name is a Kubernetes
 * object name and every part of it is also a label value, so each surface's
 * ids are checked rather than trusted: a Discord snowflake is already both, a
 * Slack channel is uppercase and a Slack thread is a timestamp whose dot is
 * legal in a label value but is spelled as a dash here so one name reads as
 * one name.
 */
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
 * What a spare is called. It is minted before any thread has asked for one so
 * it cannot be named after a thread, and it keeps this name once adopted,
 * because renaming a live object is a delete and a create. Nothing reads a
 * sandbox's name for meaning — `list()` rebuilds a thread from its labels and
 * `resolvePod` follows `status.selector` — so the only thing lost is that
 * `kubectl get sandbox` stops reading as one thread per row, which
 * `-L lolwtf.ca/thread,lolwtf.ca/surface` puts back. Getting from a thread to
 * its pod survives the rename by label, because adoption writes the thread's
 * labels to the pod template as well as to the object.
 */
function spareName(): string {
  return `mate-spare-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * What an adopted spare's workspace is brought up to date with. A spare's
 * clone is as old as the spare, where a thread today always starts on one
 * made for it, and a shallow fetch of the same ref asks only for what the
 * checkout does not already have — the small half of the clone the init
 * container ran. The reset is what moves the worktree onto it: a pull would
 * try to merge into a shallow history.
 *
 * The ref is handed to the shell as an argument rather than written into the
 * script, so that a branch name is a branch name to `sh` as well as to git —
 * the same way the init container passes it, which is argv and no shell.
 */
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

/** A digest is already the whole identity of an image, so a cached copy of one is never stale. */
function pullPolicy(image: string): string {
  return image.includes('@sha256:') ? 'IfNotPresent' : 'Always';
}

/**
 * What the harness reads instead of the checkout's own `.opencode/`.
 *
 * AGENTS.md has to be named here. opencode finds the repo's skills by walking
 * up from the cwd for `.agents/` and `.claude/` whatever the project config is
 * doing, so the agent already arrives holding every `SKILL.md` under
 * `.agents/skills/` — and none of the hard rules those skills are written on
 * top of, because instruction files come with the project config this harness
 * turns off.
 *
 * That walk is also why `dotfiles/skills/` has to be named: it is neither of
 * the two directory names, so the six skills in it are invisible to the agent
 * until something points at them. Measured in a clone with `opencode debug
 * skill`, the checkout offers 14 and the walk alone finds 8.
 *
 * Both paths are absolute because a relative one resolves against opencode's
 * own config directory, and neither that nor a file that is not there is
 * reported: a wrong path here fails open.
 */
export function opencodeConfig(model: string): string {
  return JSON.stringify({
    model,
    instructions: [`${WORKSPACE}/AGENTS.md`],
    skills: { paths: [`${WORKSPACE}/dotfiles/skills`] },
    permission: 'allow',
    autoupdate: false,
    share: 'disabled',
  });
}

/**
 * The git configuration both containers are handed as environment.
 * `GIT_CONFIG_COUNT` and its numbered pairs are git's command scope, which is
 * protected configuration, so `safe.directory` is honoured there and nothing
 * has to be written into an image or a home directory to make it stick.
 *
 * It is what makes the checkout usable at all. kubelet's fsGroup chown sets an
 * emptyDir mount root's gid and leaves its uid as root, so the workspace root
 * is uid 0 whoever clones into it, and git checks the worktree root as well as
 * the git directory: the clone succeeds and every command after it dies
 * `detected dubious ownership`. opencode reads that as "not a repository" and
 * silently drops its snapshots, and the agent's own git commands fail the same
 * way.
 *
 * The credential helper rides in the same mechanism, for the containers that
 * are given one: it is configuration git already reads from here, so nothing
 * is written into the image or into the checkout's `.git/config`, where a
 * credential would outlive the push. The checkout is handed none — it clones a
 * public repository anonymously — and the count and the indices are derived
 * from the list so a setting cannot be added without both moving with it.
 */
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
    // A helper that fails leaves git asking for a username, and whether that
    // question blocks depends on whether the agent's tool gave the command a
    // terminal. This makes it an error either way.
    ...(github
      ? [
          { name: 'GIT_TERMINAL_PROMPT', value: '0' },
          // Named for the helper above and read again by the image's `gh`
          // wrapper, which is why it is env rather than a path either of them
          // hardcodes: one name, one place it is written.
          { name: TOKEN_FILE_ENV, value: TOKEN_FILE },
        ]
      : []),
  ];
}

/**
 * The 1Password Connect environment the credential helper runs under: an
 * address and a token, and the reference that says which secret to read.
 *
 * `OP_SERVICE_ACCOUNT_TOKEN` is absent and has to stay absent. With both it
 * and `OP_CONNECT_HOST` set, `op` takes the Connect path without saying so,
 * and a token belonging to the other path then fails as a hang rather than as
 * an error.
 */
function connectEnv(vault: VaultConfig): Record<string, unknown>[] {
  return [
    { name: 'OP_CONNECT_HOST', value: vault.connectHost },
    {
      name: 'OP_CONNECT_TOKEN',
      valueFrom: {
        secretKeyRef: {
          name: vault.connectSecret,
          key: 'OP_CONNECT_TOKEN',
          // A missing Secret would otherwise hold every sandbox in
          // CreateContainerConfigError until it arrives, and a thread that
          // wanted an answer rather than a pull request would never get one.
          // Unset instead fails at the push, where the credential is what is
          // missing.
          optional: true,
        },
      },
    },
  ];
}

export interface SandboxDeclaration {
  name: string;
  namespace: string;
  /** The object's labels, and the pod template's: one set, written once. */
  labels: Record<string, string>;
  config: SandboxConfig;
  shutdownTime: string;
}

/**
 * What every sandbox mate mints carries whoever it is for. The first of these
 * is the one `sandbox-network-policy.yaml` selects on, which is why a spare —
 * which runs the same image with the same permissions — has to carry it too.
 */
function baseLabels(guildId: string): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'mate-sandbox',
    'app.kubernetes.io/part-of': 'mate',
    [MINTED_BY_LABEL]: MINTED_BY,
    [GUILD_LABEL]: guildId,
  };
}

/** The three that say whose sandbox this is; adoption is these arriving at once. */
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

/** Adoption, as one merge patch reads it: the thread arrives, the marker goes. */
function claimLabels(thread: ThreadRef): Record<string, string | null> {
  return { ...threadLabels(thread), [SPARE_LABEL]: null };
}

/** The reverse, and then some: a merge patch removes a label by nulling its key. */
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
      // Controller-enforced rather than mate-enforced: this is the only thing
      // that reaps the sandbox if mate stops running. Every turn slides it.
      shutdownTime,
      shutdownPolicy: 'Delete',
      podTemplate: {
        metadata: { labels },
        spec: {
          runtimeClassName: config.runtimeClass,
          // A sandbox runs agent-authored commands with every permission
          // allowed, and no node here is tainted, so this term is the only
          // thing keeping one off a control-plane node.
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
          // The agent runs arbitrary commands; it does not need the address of
          // every Service in the namespace handed to it in its environment.
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: AGENT_UID,
            runAsGroup: AGENT_UID,
            // Makes the emptyDirs group-writable by the harness uid, which is
            // what lets the checkout run as 1337 rather than as root.
            fsGroup: AGENT_UID,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          initContainers: [
            {
              name: CHECKOUT_CONTAINER,
              image: config.image,
              imagePullPolicy: pullPolicy(config.image),
              // Cloned by the uid the harness runs as, so every file in the
              // checkout is the agent's to write. That settles the files and
              // nothing else: the mount root itself stays uid 0, which is
              // what `gitEnv()` is for.
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
                  value: opencodeConfig(config.model),
                },
                // opencode npm-installs `@opencode-ai/plugin` into any
                // `.opencode/` it honours, whether or not a plugin is declared
                // there, and npm is not in the sandbox's egress allow-list.
                // Nothing in the checkout's own config buys that back: it
                // declares one MCP server, and its command is `nix`, which
                // this image does not carry.
                { name: 'OPENCODE_DISABLE_PROJECT_CONFIG', value: '1' },
                ...(config.vault ? connectEnv(config.vault) : []),
                ...gitEnv(config.github),
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

/**
 * The pod behind a Ready Sandbox, found through `status.selector` — the
 * `agents.x-k8s.io/pod-name` annotation the controller used to write is
 * deprecated and v1.0.x no longer sets it.
 */
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

/** Lists, then watches from that revision, until the named object is gone or the deadline passes. */
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
  /** The sweep in flight, so the cadence and a mint's replacement never run two. */
  private warming: Promise<void> | null = null;
  /** Set by a call that arrived mid-pass: the pool changed after that pass counted it. */
  private again = false;
  /** Cleared by the first pass, which keeps none of the spares it inherited. */
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
      // A sandbox carrying the spare marker at either of its values belongs
      // to no thread by design, so it is skipped before the warning below,
      // which is about an object that should have had thread labels.
      if (labels[SPARE_LABEL]) continue;
      const id = labels[THREAD_LABEL];
      const channelId = labels[CHANNEL_LABEL];
      // Discord is the default because its threads are the ones whose labels
      // can predate the surface label; anything else names itself.
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

  /**
   * The sandbox this thread talks to, in the order that costs it least: the
   * one it already has, then a spare that is already warm, then a new one.
   */
  async mint(thread: ThreadRef, onStep?: OnMintStep): Promise<MintedRef> {
    const existing = await this.find(thread);
    if (existing) return this.reuse(existing, thread, onStep);
    const taken = await this.adopt(thread, onStep);
    if (taken) {
      // The pool is one short from here on, and the thread that just took the
      // spare is the last one that should be made to wait for its successor.
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
   * Tops the pool up and renews what is in it, which is the renewal
   * `SPARE_TTL_MS` is written against.
   *
   * A pass already in flight counted the pool before whatever prompted this
   * call, so joining it would answer about a pool that had not changed yet —
   * the thread that just took the spare would get no replacement. It is
   * waited out and another follows it instead.
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
    // Nothing is registered until the object carries the session and the
    // slid TTL: a rejected attach must not leave a live harness behind a
    // caller that believes it failed.
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
      // In a `finally` because every way a turn can end is a way the token
      // stops being needed: an answer, a stop, a timeout, a stream that died
      // under it. Leaving one behind is what would make the hour matter
      // rather than the turn.
      await this.retireToken(name, attachment.pod, token);
    }
    // The turn already happened; a failed slide is a shorter TTL and a stale
    // turn mark, not a failed answer.
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

  /**
   * Mints the turn's GitHub token and writes it into the sandbox, answering
   * with what was written so the turn can hand it back.
   *
   * Neither half fails the turn. A thread that cannot push can still read,
   * explain and answer, and taking the whole turn away because a credential
   * is unavailable would turn a degraded feature into an outage. What says so
   * instead is the metric, the alert, and — for the human waiting — the
   * `gh` wrapper and the credential helper, which both report a token that is
   * not there in words about the token.
   *
   * The token goes in argv rather than stdin because `ExecStream` has no
   * half-close (`kube.ts`), so a `cat > file` would wait for an EOF that
   * never comes. `refreshScript` passes a branch name the same way and for
   * the same reason. That does put the token in the pod's own process table
   * for the length of one `printf`, which is moot where every command is
   * already the agent's, and in the apiserver audit log — which offsite does
   * not run: its apiserver carries no `--audit-policy-file`, and without one
   * Kubernetes writes no audit events at all. An estate that turns auditing
   * on wants this served over a socket instead.
   */
  private async stampToken(name: string, pod: string): Promise<string | null> {
    const { githubApp, log, metrics } = this.deps;
    if (!githubApp) return null;
    let token: string;
    try {
      token = (await githubApp.token()).token;
      metrics?.githubTokenMinted('ok');
    } catch (error) {
      metrics?.githubTokenMinted('mint-failed');
      log.error('could not mint a GitHub token for this turn', {
        sandbox: name,
        error: plain(error),
      });
      // Truncated rather than left alone, so a turn never pushes with the
      // token of a turn that has already ended.
      await this.writeToken(pod, '').catch(() => {});
      return null;
    }
    try {
      await this.writeToken(pod, token);
      metrics?.githubTokenStamped('ok');
      return token;
    } catch (error) {
      metrics?.githubTokenStamped('stamp-failed');
      log.error('could not stamp the GitHub token into the sandbox', {
        sandbox: name,
        error: plain(error),
      });
      // Handed back at once: it reaches nobody, so nothing is served by
      // letting it live out its hour.
      await githubApp.revoke(token).catch(() => {});
      return null;
    }
  }

  /** Truncates the sandbox's copy and spends the token, both best-effort. */
  private async retireToken(
    name: string,
    pod: string,
    token: string | null,
  ): Promise<void> {
    if (!token) return;
    await this.writeToken(pod, '').catch((error) =>
      this.deps.log.warn('could not clear the GitHub token', {
        sandbox: name,
        error: plain(error),
      }),
    );
    await this.deps.githubApp?.revoke(token).catch((error: unknown) =>
      this.deps.log.warn('could not revoke the GitHub token', {
        sandbox: name,
        error: plain(error),
      }),
    );
  }

  /** One exec: the file written 0600, or truncated when the value is empty. */
  private async writeToken(pod: string, token: string): Promise<void> {
    const stream = await this.deps.kube.exec({
      namespace: this.namespace,
      pod,
      container: HARNESS_CONTAINER,
      // `umask` before the redirection, so the file is never briefly 0644 —
      // `chmod` after the write would be exactly that race.
      command: [
        '/bin/sh',
        '-c',
        `umask 077; printf %s "$1" > ${TOKEN_FILE}`,
        'mate',
        token,
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
    // Required rather than merely not-a-failure, for the reason `refresh`
    // gives: a stream that ended carrying no status is a command whose exit
    // nobody saw, and here that means a file that may hold nothing.
    if (close.status?.status !== 'Success') {
      throw new Error(
        `writing the token said ${close.status?.message || close.reason}`,
      );
    }
  }

  async cancel(session: Session): Promise<void> {
    // A re-attach whose `session/load` failed holds a different session id,
    // and cancelling one the harness never minted stops nothing.
    const attachment = this.attached.get(session.sandbox.name);
    if (attachment?.sessionId !== session.id) return;
    await attachment.client.cancel(session.id);
  }

  async teardown(ref: SandboxRef): Promise<void> {
    await this.destroy(ref.name);
  }

  /** The pod a live attachment is exec'd into, for the smoke's delete timing. */
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
   * This thread's own sandbox, found by its label rather than by its name: a
   * sandbox adopted from the pool answers to a name no thread would derive,
   * and the label is the only thing that says whose it is. It reaches further
   * than `list()` does on purpose — an object carrying a thread label and no
   * channel one is not a thread mate can rehydrate, but it is still this
   * thread's sandbox, and minting a second one beside it would leak the first.
   *
   * What it will not reach is an object on its way out. The thread is asking
   * for a sandbox to talk to and a terminating one is what it is waiting to
   * be rid of, so handing it back would turn a mint that could have succeeded
   * into the hard failure `reuse` raises — which is why it is filtered here
   * the way `list()` and `spares()` filter it.
   */
  private async find(thread: ThreadRef): Promise<Sandbox | undefined> {
    const list = await this.deps.kube.json<KubeList<Sandbox>>(this.path(), {
      query: {
        labelSelector: `${this.selector()},${THREAD_LABEL}=${thread.id}`,
      },
    });
    // Both are checked rather than selected on, and both default to what the
    // thread says, because a Discord sandbox minted before either label
    // existed carries the thread id and nothing else. Checking the channel is
    // what keeps a Slack `thread_ts` — unique per channel, not per workspace —
    // from reaching a second channel's thread of the same stamp, which the
    // name this lookup replaces was immune to by construction.
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

  /** Today's path, and the only one that names a sandbox after its thread. */
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
    // `find` just looked and saw nothing, so a name that is taken is taken by
    // an object no label can reach — the backstop, not the dedup.
    if (response.status === 409) {
      return this.reuse(
        await kube.json<Sandbox>(this.path(name)),
        thread,
        onStep,
      );
    }
    // The whole of the cold start is inside this one wait — scheduling, the
    // image, the microVM boot and the clone — so it is the step a human
    // watching the line spends almost all of the wait looking at.
    onStep?.('booting');
    await this.waitUsable(name);
    return { name, thread, source: 'fresh' };
  }

  private async waitUsable(name: string): Promise<void> {
    try {
      await this.waitReady(name);
    } catch (error) {
      // `shutdownTime` is hours away, so an object left here outlives the
      // thread that asked for it and can still be scheduled once whatever
      // held it up clears — with nobody left to talk to it.
      await this.destroy(name).catch((failure) =>
        this.deps.log.warn('could not delete a sandbox that never came up', {
          sandbox: name,
          error: plain(failure),
        }),
      );
      throw error;
    }
  }

  /**
   * Hands a warm spare to a thread: one merge patch that swaps the spare
   * marker for the thread's labels and gives the object a thread's TTL.
   *
   * The `resourceVersion` listed at is what makes two mints at once safe. The
   * apiserver reads a merge patch carrying one as an update from that
   * revision, so the second of two threads reaching the same spare is refused
   * with a 409 and goes looking for another.
   *
   * The same labels are written to the pod template in the same patch, and
   * that is deliberate rather than tidiness. At v1.0.3 the controller never
   * re-applies a pod's spec to a pod that already exists, but it does
   * propagate `spec.podTemplate.metadata.labels` onto one — so writing them
   * there moves the running pod onto the thread's labels and off the spare
   * marker without recreating it, and `kubectl get pods -l lolwtf.ca/thread`
   * keeps answering for a sandbox named after no thread. Leaving the template
   * alone would have left the object disagreeing with itself.
   */
  private async adopt(
    thread: ThreadRef,
    onStep?: OnMintStep,
  ): Promise<MintedRef | null> {
    const { config, log } = this.deps;
    // Nothing to adopt and no question worth asking: with the pool off a mint
    // is the two requests it has always been, and an apiserver hiccup on a
    // list mate had no reason to make would cost a thread its answer.
    if (config.spares === 0) return null;
    const labels = claimLabels(thread);
    for (const spare of await this.spares()) {
      if (!isReady(spare)) continue;
      const name = spare.metadata.name;
      onStep?.('adopting');
      try {
        await this.patch(name, {
          metadata: {
            resourceVersion: spare.metadata.resourceVersion,
            labels,
          },
          spec: {
            shutdownTime: this.shutdownTime(),
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
        // A thread that cannot be given a current checkout is better served
        // by the slow path than by an agent reading a repository that has
        // moved on. The labels come off before the delete is even asked for,
        // because the caller is about to mint a second sandbox for this
        // thread and a delete that does not land would otherwise leave two
        // objects answering to it. If that patch is itself refused the mint
        // fails here rather than duplicating the thread: what is left is one
        // Ready sandbox wearing the thread, which the next message reuses.
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
   * Takes a sandbox out of circulation and then deletes it. The patch is
   * awaited because it is what makes the object unreachable — no thread's
   * labels, and a spare marker the pool does not select on — and the delete
   * is not, because by then nothing can be handed the object either way and
   * `destroy` waits up to three minutes on a teardown nobody is blocked on.
   *
   * A caller condemning something it only saw in a list passes the revision
   * it saw it at, and takes the 409 as its answer: what is being taken away
   * here is deleted straight afterwards, so doing it to an object that has
   * moved since would be doing it to whatever moved it.
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

  /**
   * Brings an adopted spare's checkout up to date, in the harness container
   * because that is where the git configuration and the one GitHub name the
   * network policy allows already are, and before the ACP attach because
   * opencode snapshots the workspace as it finds it.
   */
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
        // Redacted as it arrives, because this is the one stderr that ends up
        // inside a thrown Error rather than going straight to `log.warn`.
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
    // Success is required rather than a failure refused: a stream that ended
    // carrying no status at all is a command whose exit nobody saw, and a
    // workspace that may not have moved.
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
    // With the pool off the pass costs nothing at all, not even the list: the
    // default is off, and a mate nobody has configured a pool for should not
    // be asking the apiserver about one every few minutes.
    if (want === 0) return;
    if (this.inherited) await this.discard();
    const ready: Sandbox[] = [];
    // Ones that stopped being Ready and would not go. They count against the
    // pool even though no thread can be handed them, because what a spare
    // takes is room on the one node sandboxes land on, and minting beside a
    // sandbox that is still standing there would put the pool over its size.
    let stuck = 0;
    for (const spare of await this.spares()) {
      if (isReady(spare)) {
        ready.push(spare);
        continue;
      }
      // `mintSpare` does not return until its spare is Ready and two passes
      // never overlap, so one that is not Ready here was Ready and stopped
      // being it — an evicted pod, a node that went away. `adopt` refuses
      // such a thing, so leaving it in place holds the pool at nothing usable
      // while it reads as full, and the renewal below is what would make that
      // permanent: a spare's TTL is the only thing that ever takes one away.
      const name = spare.metadata.name;
      try {
        await this.condemn(name, spare.metadata.resourceVersion);
        log.info('condemned a spare that stopped being ready', {
          sandbox: name,
        });
      } catch (error) {
        // The precondition is here for the reason it is on the renewal below,
        // and losing to it is the wanted outcome: the only thing that moves a
        // spare between the list and the patch is a thread claiming it or the
        // controller reaping it, and neither of those wants a condemned
        // sandbox's labels written over it. The pool is one short either way,
        // and the mint below is what answers that.
        if (error instanceof KubeError && error.status === 409) continue;
        stuck += 1;
        log.warn('could not condemn a spare that stopped being ready', {
          sandbox: name,
          error: plain(error),
        });
      }
    }
    // Only what is wanted is renewed. Past that nothing is slid and nothing
    // is deleted, because a spare's short `shutdownTime` already removes one
    // nobody renews, and turning the knob down needs no second mechanism.
    for (const spare of ready.slice(0, want)) {
      try {
        await this.patch(spare.metadata.name, {
          metadata: { resourceVersion: spare.metadata.resourceVersion },
          spec: { shutdownTime: this.spareShutdownTime() },
        });
      } catch (error) {
        // The precondition is here for the same reason it is on adoption, and
        // losing to it is the wanted outcome: a spare that moved between the
        // list and the patch was taken by a thread or reaped, and neither of
        // those wants a spare's half hour written back over it. Anything else
        // costs one member of the pool rather than the pass.
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
        // The first failure ends the pass rather than asking for another
        // sandbox the apiserver or the node just refused. Nothing is waiting
        // on the pool, and the next tick is minutes away.
        log.warn('warming a spare failed', { error: plain(error) });
        break;
      }
    }
    // What a thread could be handed if it asked now — a condemned or stuck
    // spare is room on the node and nothing else, so neither is in this. A
    // pool that has stopped refilling looks healthy from every other angle:
    // threads still get their answers, at the cold-start price the pool was
    // turned on to stop paying.
    this.deps.metrics?.spares(warm, want);
  }

  /**
   * Keeps none of the spares this mate did not warm. A spare outlives a roll
   * — one replica, `Recreate`, seconds of downtime — and it was built from
   * whatever the Deployment said at the time: its sandbox image, its model,
   * its checkout. Nothing on the object records which, so the first pass
   * spends one warming to know that every spare it hands out is running what
   * this mate was told to run.
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
    // Stays set while any of them is still there, because the alternative is
    // renewing an inherited spare's half hour for the rest of the day.
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

  /** `session/load` first, a fresh session when the harness cannot replay it. */
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

  /**
   * A mate that died mid-session left its harness running with no reader; two
   * `opencode acp` processes would share one state directory.
   */
  private async reap(name: string, pod: string): Promise<void> {
    const { kube, log } = this.deps;
    try {
      const stream = await kube.exec({
        namespace: this.namespace,
        pod,
        container: HARNESS_CONTAINER,
        // Matched on the process name, not the command line: `-f` would match
        // this shell's own arguments and kill the reaper instead.
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

  /** Slides the TTL and ends the turn mark in one write: both happen together. */
  private async slide(name: string): Promise<void> {
    await this.patch(name, {
      spec: { shutdownTime: this.shutdownTime() },
      metadata: { annotations: { [TURN_ANNOTATION]: null } },
    });
  }

  /**
   * Opens the turn mark, and slides the TTL with it. The controller deletes a
   * sandbox the moment `shutdownTime` passes and does not care that a turn is
   * streaming out of it. Sliding only at the ends of a turn left the next one
   * whatever the quiet timer had not already spent, which made
   * `MATE_QUIET_MINUTES` a silent bound on how long a turn could run; sliding
   * here is what decouples them, so a turn's window is the TTL and nothing
   * else.
   */
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
