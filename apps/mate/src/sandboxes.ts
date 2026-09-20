/**
 * Sandboxes on the cluster: one bare `agents.x-k8s.io/v1beta1` Sandbox per
 * thread, the harness reached by exec-ing `opencode acp` in its pod,
 * and `spec.shutdownTime` slid forward after every turn so a mate that dies
 * mid-thread cannot leak one.
 */
import { AcpClient } from './acp.ts';
import type { SandboxConfig } from './config.ts';
import {
  type Kube,
  type KubeList,
  type KubeObject,
  kubeError,
  ok,
} from './kube.ts';
import { type Log, plain } from './log.ts';
import type {
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
const GIT_USER = 'rowbutt';
const GIT_EMAIL = '22780844+rowbutt@users.noreply.github.com';

export const TTL_MS = 2 * 60 * 60_000;
const READY_TIMEOUT_MS = 300_000;
const GONE_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 15 * 60_000;
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
  ttlMs?: number;
  turnTimeoutMs?: number;
  readyTimeoutMs?: number;
  goneTimeoutMs?: number;
}

interface Attachment {
  client: AcpClient;
  sessionId: string;
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
 */
export function gitEnv(): { name: string; value: string }[] {
  const settings: [string, string][] = [
    ['safe.directory', WORKSPACE],
    ['user.name', GIT_USER],
    ['user.email', GIT_EMAIL],
  ];
  return [
    { name: 'GIT_CONFIG_COUNT', value: String(settings.length) },
    ...settings.flatMap(([key, value], index) => [
      { name: `GIT_CONFIG_KEY_${index}`, value: key },
      { name: `GIT_CONFIG_VALUE_${index}`, value },
    ]),
  ];
}

export interface SandboxDeclaration {
  name: string;
  namespace: string;
  thread: ThreadRef;
  guildId: string;
  config: SandboxConfig;
  shutdownTime: string;
}

export function sandboxLabels(
  thread: ThreadRef,
  guildId: string,
): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'mate-sandbox',
    'app.kubernetes.io/part-of': 'mate',
    [MINTED_BY_LABEL]: MINTED_BY,
    [SURFACE_LABEL]: thread.surface,
    [THREAD_LABEL]: thread.id,
    [CHANNEL_LABEL]: thread.channelId,
    [GUILD_LABEL]: guildId,
  };
}

export function sandboxManifest(declaration: SandboxDeclaration): Sandbox {
  const { name, namespace, thread, guildId, config, shutdownTime } =
    declaration;
  const labels = sandboxLabels(thread, guildId);
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
                '1',
                '--branch',
                config.checkoutRef,
                config.checkoutRepo,
                WORKSPACE,
              ],
              env: gitEnv(),
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
                ...gitEnv(),
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

  async mint(thread: ThreadRef): Promise<SandboxRef> {
    const { kube, log } = this.deps;
    const name = sandboxName(thread);
    const response = await kube.request(this.path(), {
      method: 'POST',
      body: sandboxManifest({
        name,
        namespace: this.namespace,
        thread,
        guildId: this.deps.guildId,
        config: this.deps.config,
        shutdownTime: this.shutdownTime(),
      }),
    });
    if (!ok(response, 409)) throw await kubeError(response);
    await drain(response);
    if (response.status === 409) {
      const existing = await kube.json<Sandbox>(this.path(name));
      if (existing.metadata.deletionTimestamp) {
        throw new Error(`sandbox ${name} is still terminating`);
      }
      log.info('sandbox already existed', { sandbox: name });
    }
    try {
      await this.waitReady(name);
    } catch (error) {
      // `shutdownTime` is hours away, so an object left here outlives the
      // thread that asked for it and can still be scheduled once whatever
      // held it up clears — with nobody left to talk to it.
      await this.teardown({ name, thread }).catch((failure) =>
        log.warn('could not delete a sandbox that never came up', {
          sandbox: name,
          error: plain(failure),
        }),
      );
      throw error;
    }
    return { name, thread };
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
    const attachment: Attachment = { client, sessionId: session.id };
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
    const result = await attachment.client.prompt(
      session.id,
      text,
      sink,
      this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS,
    );
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

  async cancel(session: Session): Promise<void> {
    // A re-attach whose `session/load` failed holds a different session id,
    // and cancelling one the harness never minted stops nothing.
    const attachment = this.attached.get(session.sandbox.name);
    if (attachment?.sessionId !== session.id) return;
    await attachment.client.cancel(session.id);
  }

  async teardown(ref: SandboxRef): Promise<void> {
    const { kube } = this.deps;
    this.detach(ref.name);
    const response = await kube.request(this.path(ref.name), {
      method: 'DELETE',
    });
    if (!ok(response, 404)) throw await kubeError(response);
    await drain(response);
    await waitUntilGone(
      kube,
      this.path(),
      ref.name,
      this.deps.goneTimeoutMs ?? GONE_TIMEOUT_MS,
    );
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

  private async mark(name: string): Promise<void> {
    await this.patch(name, {
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
