/**
 * Sandboxes on the cluster: one bare `agents.x-k8s.io/v1beta1` Sandbox per
 * Discord thread, the harness reached by exec-ing `opencode acp` in its pod,
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

export const SANDBOX_API = 'agents.x-k8s.io/v1beta1';
const SANDBOXES = '/apis/agents.x-k8s.io/v1beta1';
const PODS = '/api/v1';

export const MINTED_BY = 'mate';
export const MINTED_BY_LABEL = 'lolwtf.ca/minted-by';
export const THREAD_LABEL = 'lolwtf.ca/thread';
export const CHANNEL_LABEL = 'lolwtf.ca/channel';
export const GUILD_LABEL = 'lolwtf.ca/guild';
/**
 * The harness's own session id, kept on the object rather than in a label:
 * mate stores whatever the harness minted, and a label value is restricted to
 * 63 characters of `[A-Za-z0-9._-]`.
 */
export const SESSION_ANNOTATION = 'lolwtf.ca/acp-session';

export const HARNESS_CONTAINER = 'harness';
export const CHECKOUT_CONTAINER = 'checkout';
export const WORKSPACE = '/workspace';
export const AGENT_HOME = '/home/agent';
export const AGENT_UID = 1337;

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
const THREAD_ID = /^\d{15,22}$/;

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

export function sandboxName(threadId: string): string {
  if (!THREAD_ID.test(threadId)) {
    throw new Error(`thread id ${threadId} is not a snowflake`);
  }
  return `mate-${threadId}`;
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

/** What the harness reads instead of the checkout's own `.opencode/`. */
export function opencodeConfig(model: string): string {
  return JSON.stringify({
    model,
    permission: 'allow',
    autoupdate: false,
    share: 'disabled',
  });
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
              // Cloned by the uid the harness runs as: git refuses to operate
              // in a tree owned by another user ("dubious ownership").
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
                // The checkout's own `.opencode/package.json` fires hundreds of
                // npm requests at every start, and npm is not in the sandbox's
                // egress allow-list.
                { name: 'OPENCODE_DISABLE_PROJECT_CONFIG', value: '1' },
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
      if (!id || !channelId) {
        this.deps.log.warn('sandbox has no thread labels; ignoring it', {
          sandbox: sandbox.metadata.name,
        });
        continue;
      }
      refs.push({ name: sandbox.metadata.name, thread: { id, channelId } });
    }
    return refs;
  }

  async mint(thread: ThreadRef): Promise<SandboxRef> {
    const { kube, log } = this.deps;
    const name = sandboxName(thread.id);
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
    await this.waitReady(name);
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
    let sessionId: string;
    // Nothing is registered until the object carries the session and the
    // slid TTL: a rejected attach must not leave a live harness behind a
    // caller that believes it failed.
    try {
      await client.initialize();
      sessionId = await this.openSession(client, ref.name, stored);
      if (sessionId !== stored) await this.remember(ref.name, sessionId);
      await this.slide(ref.name);
    } catch (error) {
      client.close();
      throw error;
    }
    const attachment: Attachment = { client, sessionId };
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
    return { id: sessionId, sandbox: ref };
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
    const result = await attachment.client.prompt(
      session.id,
      text,
      sink,
      this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS,
    );
    // The turn already happened; a failed slide is a shorter TTL, not a
    // failed answer.
    await this.slide(name).catch((error) =>
      this.deps.log.warn('shutdownTime slide failed', {
        sandbox: name,
        error: plain(error),
      }),
    );
    return { stopReason: result.stopReason, error: result.error };
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
  ): Promise<string> {
    const { log } = this.deps;
    if (stored) {
      try {
        await client.loadSession(stored, WORKSPACE);
        log.info('acp session loaded', { sandbox: name, session: stored });
        return stored;
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
    return fresh;
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

  private async slide(name: string): Promise<void> {
    await this.patch(name, { spec: { shutdownTime: this.shutdownTime() } });
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
