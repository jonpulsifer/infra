/**
 * The slice of the Kubernetes API mate uses, on Bun's own `fetch` and
 * `WebSocket`: credentials from the pod's ServiceAccount mount or a
 * workstation kubeconfig, every request bounded, and a `pods/exec` stream
 * whose `v4.channel.k8s.io` byte framing becomes plain stdin/stdout streams.
 */
import { dirname, resolve } from 'node:path';

export const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const EXEC_PROTOCOL = 'v4.channel.k8s.io';
const REQUEST_TIMEOUT_MS = 15_000;
const EXEC_OPEN_TIMEOUT_MS = 30_000;
const EXEC_PLUGIN_TIMEOUT_MS = 30_000;
const CREDENTIAL_SLACK_MS = 60_000;

type Env = Record<string, string | undefined>;

export interface Credentials {
  token?: string;
  cert?: string;
  key?: string;
}

export interface KubeConfig {
  readonly server: string;
  readonly namespace: string;
  /** PEM bundle the server must chain to; absent means the system store. */
  readonly ca?: string;
  readonly insecure?: boolean;
  /** Read per request: a projected ServiceAccount token rotates under a running pod. */
  readonly credentials: () => Promise<Credentials>;
}

export class KubeError extends Error {
  override readonly name = 'KubeError';
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export interface ObjectMeta {
  name: string;
  namespace?: string;
  uid?: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  deletionTimestamp?: string;
  ownerReferences?: { kind?: string; name?: string; uid?: string }[];
}

export interface KubeObject<Spec = unknown, Status = unknown> {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
  spec: Spec;
  status?: Status;
}

export interface KubeList<T> {
  metadata: { resourceVersion?: string };
  items: T[];
}

export interface WatchEvent<T> {
  type: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK' | 'ERROR';
  object: T;
}

export interface KubeStatus {
  status?: 'Success' | 'Failure';
  message?: string;
  reason?: string;
  code?: number;
  details?: { causes?: { reason?: string; message?: string }[] };
}

export interface RequestOptions {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
  contentType?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecOptions {
  namespace?: string;
  pod: string;
  container: string;
  command: string[];
  onStderr?(text: string): void;
  timeoutMs?: number;
}

export interface ExecClose {
  code: number;
  reason: string;
  status: KubeStatus | null;
}

export interface ExecStream {
  readonly stdout: ReadableStream<Uint8Array>;
  /** Stays open for the life of the stream: v4 framing has no half-close, and kata-clh drops stdout after stdin EOF. */
  readonly stdin: WritableStream<Uint8Array>;
  readonly closed: Promise<ExecClose>;
  close(): void;
}

export async function inClusterConfig(
  env: Env = process.env,
  dir = SA_DIR,
): Promise<KubeConfig | null> {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? '443';
  const token = Bun.file(`${dir}/token`);
  if (!host || !(await token.exists())) return null;
  const server = host.includes(':')
    ? `https://[${host}]:${port}`
    : `https://${host}:${port}`;
  return {
    server,
    namespace: (await Bun.file(`${dir}/namespace`).text()).trim(),
    ca: await Bun.file(`${dir}/ca.crt`).text(),
    credentials: async () => ({ token: (await token.text()).trim() }),
  };
}

interface Kubeconfig {
  'current-context'?: string;
  contexts?: { name: string; context: KubeconfigContext }[];
  clusters?: { name: string; cluster: KubeconfigCluster }[];
  users?: { name: string; user: KubeconfigUser }[];
}

interface KubeconfigContext {
  cluster: string;
  user: string;
  namespace?: string;
}

interface KubeconfigCluster {
  server: string;
  'certificate-authority'?: string;
  'certificate-authority-data'?: string;
  'insecure-skip-tls-verify'?: boolean;
}

interface KubeconfigUser {
  token?: string;
  tokenFile?: string;
  'client-certificate'?: string;
  'client-certificate-data'?: string;
  'client-key'?: string;
  'client-key-data'?: string;
  exec?: ExecPlugin;
}

interface ExecPlugin {
  apiVersion: string;
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  provideClusterInfo?: boolean;
}

interface ExecCredential {
  status?: {
    token?: string;
    clientCertificateData?: string;
    clientKeyData?: string;
    expirationTimestamp?: string;
  };
}

function decode(data: string): string {
  return Buffer.from(data, 'base64').toString('utf8');
}

async function fileOrData(
  base: string,
  data: string | undefined,
  path: string | undefined,
): Promise<string | undefined> {
  if (data) return decode(data);
  if (path) return Bun.file(resolve(base, path)).text();
  return undefined;
}

function pluginCredentials(
  plugin: ExecPlugin,
  cluster: KubeconfigCluster,
  base: string,
): () => Promise<Credentials> {
  let cached: { credentials: Credentials; until: number } | null = null;
  return async () => {
    if (cached && Date.now() < cached.until) return cached.credentials;
    const info = {
      apiVersion: plugin.apiVersion,
      kind: 'ExecCredential',
      spec: {
        interactive: false,
        ...(plugin.provideClusterInfo
          ? {
              cluster: {
                server: cluster.server,
                'certificate-authority-data':
                  cluster['certificate-authority-data'],
              },
            }
          : {}),
      },
    };
    const proc = Bun.spawn([plugin.command, ...(plugin.args ?? [])], {
      cwd: base,
      env: {
        ...process.env,
        ...Object.fromEntries((plugin.env ?? []).map((e) => [e.name, e.value])),
        KUBERNETES_EXEC_INFO: JSON.stringify(info),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const timer = setTimeout(() => proc.kill(), EXEC_PLUGIN_TIMEOUT_MS);
    try {
      const out = await new Response(proc.stdout).text();
      if ((await proc.exited) !== 0) {
        throw new Error(`credential plugin ${plugin.command} failed`);
      }
      const status = (JSON.parse(out) as ExecCredential).status ?? {};
      const credentials: Credentials = {
        token: status.token,
        cert: status.clientCertificateData,
        key: status.clientKeyData,
      };
      const until = status.expirationTimestamp
        ? Date.parse(status.expirationTimestamp) - CREDENTIAL_SLACK_MS
        : Number.POSITIVE_INFINITY;
      cached = { credentials, until };
      return credentials;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function kubeconfigConfig(
  path: string,
  contextName?: string,
): Promise<KubeConfig> {
  const doc = Bun.YAML.parse(await Bun.file(path).text()) as Kubeconfig;
  const name = contextName ?? doc['current-context'];
  const context = doc.contexts?.find((c) => c.name === name)?.context;
  if (!context) throw new Error(`kubeconfig ${path}: no context ${name}`);
  const cluster = doc.clusters?.find(
    (c) => c.name === context.cluster,
  )?.cluster;
  if (!cluster) {
    throw new Error(`kubeconfig ${path}: no cluster ${context.cluster}`);
  }
  const user = doc.users?.find((u) => u.name === context.user)?.user ?? {};
  const base = dirname(path);
  const ca = await fileOrData(
    base,
    cluster['certificate-authority-data'],
    cluster['certificate-authority'],
  );
  let credentials: () => Promise<Credentials>;
  if (user.exec) {
    credentials = pluginCredentials(user.exec, cluster, base);
  } else if (user.tokenFile) {
    const file = resolve(base, user.tokenFile);
    credentials = async () => ({ token: (await Bun.file(file).text()).trim() });
  } else {
    const fixed: Credentials = {
      token: user.token,
      cert: await fileOrData(
        base,
        user['client-certificate-data'],
        user['client-certificate'],
      ),
      key: await fileOrData(base, user['client-key-data'], user['client-key']),
    };
    credentials = async () => fixed;
  }
  return {
    server: cluster.server.replace(/\/+$/, ''),
    namespace: context.namespace ?? 'default',
    ca,
    insecure: cluster['insecure-skip-tls-verify'] === true,
    credentials,
  };
}

/** The pod's own ServiceAccount when there is one, else the workstation's kubeconfig. */
export async function discoverKube(
  env: Env = process.env,
): Promise<KubeConfig> {
  const inCluster = await inClusterConfig(env);
  if (inCluster) return inCluster;
  const path =
    env.KUBECONFIG?.split(':').find(Boolean) ??
    `${env.HOME ?? ''}/.kube/config`;
  return kubeconfigConfig(path, env.MATE_KUBE_CONTEXT?.trim() || undefined);
}

/**
 * Bun's WebSocket takes protocols, headers and TLS as a second options
 * argument, but `lib.dom`'s two-overload declaration wins over bun-types
 * whenever the DOM lib is loaded, which it is here for `@discordjs/*`.
 */
type BunWebSocket = new (
  url: string | URL,
  options: Bun.WebSocketOptions,
) => WebSocket;

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class Kube {
  constructor(readonly config: KubeConfig) {}

  get namespace(): string {
    return this.config.namespace;
  }

  private tls(credentials: Credentials) {
    return {
      ca: this.config.ca,
      cert: credentials.cert,
      key: credentials.key,
      rejectUnauthorized: !this.config.insecure,
    };
  }

  private url(path: string, query?: Record<string, string>): URL {
    const url = new URL(path, `${this.config.server}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  async request(path: string, opts: RequestOptions = {}): Promise<Response> {
    const credentials = await this.config.credentials();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (credentials.token) {
      headers.Authorization = `Bearer ${credentials.token}`;
    }
    if (opts.body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
    }
    return fetch(this.url(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: withTimeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, opts.signal),
      tls: this.tls(credentials),
    });
  }

  async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, opts);
    if (!response.ok) throw await kubeError(response);
    return (await response.json()) as T;
  }

  /** One bounded watch; the caller re-lists and re-watches when it ends. */
  async *watch<T>(
    path: string,
    query: Record<string, string>,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): AsyncGenerator<WatchEvent<T>> {
    const response = await this.request(path, {
      query: {
        ...query,
        watch: 'true',
        allowWatchBookmarks: 'true',
        timeoutSeconds: String(timeoutSeconds),
      },
      timeoutMs: (timeoutSeconds + 15) * 1000,
      signal,
    });
    if (!response.ok || !response.body) throw await kubeError(response);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let at = buffer.indexOf('\n');
        while (at >= 0) {
          const line = buffer.slice(0, at).trim();
          buffer = buffer.slice(at + 1);
          if (line) yield JSON.parse(line) as WatchEvent<T>;
          at = buffer.indexOf('\n');
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  async exec(opts: ExecOptions): Promise<ExecStream> {
    const namespace = opts.namespace ?? this.config.namespace;
    const url = this.url(
      `/api/v1/namespaces/${namespace}/pods/${opts.pod}/exec`,
      {
        container: opts.container,
        stdin: 'true',
        stdout: 'true',
        stderr: 'true',
        tty: 'false',
      },
    );
    for (const word of opts.command) url.searchParams.append('command', word);
    const credentials = await this.config.credentials();
    const socketUrl = new URL(url);
    socketUrl.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new (WebSocket as unknown as BunWebSocket)(socketUrl, {
      protocols: [EXEC_PROTOCOL],
      headers: credentials.token
        ? { Authorization: `Bearer ${credentials.token}` }
        : {},
      tls: this.tls(credentials),
    });
    ws.binaryType = 'arraybuffer';

    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const stderr = new TextDecoder();
    const statusBytes: Uint8Array[] = [];
    let resolveClosed!: (close: ExecClose) => void;
    const closed = new Promise<ExecClose>((resolve) => {
      resolveClosed = resolve;
    });
    let open = false;

    ws.onmessage = (event) => {
      const bytes =
        event.data instanceof ArrayBuffer
          ? new Uint8Array(event.data)
          : new TextEncoder().encode(String(event.data));
      if (bytes.length === 0) return;
      const payload = bytes.subarray(1);
      switch (bytes[0]) {
        case 1:
          if (payload.length > 0) {
            // A cancelled reader makes enqueue throw, and this is an event
            // handler: whatever the harness says next is moot either way.
            try {
              stdoutController.enqueue(payload);
            } catch {}
          }
          break;
        case 2:
          opts.onStderr?.(stderr.decode(payload, { stream: true }));
          break;
        case 3:
          statusBytes.push(payload);
          break;
      }
    };
    ws.onclose = (event) => {
      try {
        stdoutController.close();
      } catch {}
      resolveClosed({
        code: event.code,
        reason: event.reason,
        status: parseStatus(statusBytes),
      });
    };

    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        if (ws.readyState !== WebSocket.OPEN) {
          throw new Error('exec stream is closed');
        }
        const frame = new Uint8Array(chunk.length + 1);
        frame.set(chunk, 1);
        ws.send(frame);
      },
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`exec to ${opts.pod} did not open in time`));
      }, opts.timeoutMs ?? EXEC_OPEN_TIMEOUT_MS);
      ws.onopen = () => {
        clearTimeout(timer);
        open = true;
        resolve();
      };
      ws.onerror = () => {};
      void closed.then(async (close) => {
        clearTimeout(timer);
        if (!open) reject(new Error(await this.explainExec(url, close.reason)));
      });
    });
    return {
      stdout,
      stdin,
      closed,
      close: () => ws.close(1000, 'mate closed'),
    };
  }

  /**
   * A refused upgrade reaches Bun's WebSocket as a bare close, so the plain
   * GET on the same URL fetches the apiserver's answer: 403 names the missing
   * RBAC, 404 says the pod is gone, and 400 "Upgrade request required" means
   * the pod is there and the fault lies elsewhere.
   */
  private async explainExec(url: URL, reason: string): Promise<string> {
    try {
      const response = await this.request(url.pathname + url.search);
      const status = (await response
        .json()
        .catch(() => null)) as KubeStatus | null;
      const said = status?.message ?? response.statusText;
      return `exec refused (${reason}); apiserver says ${response.status} ${said}`;
    } catch (error) {
      return `exec refused (${reason}); ${String(error)}`;
    }
  }
}

export function ok(response: Response, ...statuses: number[]): boolean {
  return response.ok || statuses.includes(response.status);
}

export async function kubeError(response: Response): Promise<KubeError> {
  const status = (await response.json().catch(() => null)) as KubeStatus | null;
  return new KubeError(
    response.status,
    status?.message ?? `${response.status} ${response.statusText}`,
    status?.reason,
  );
}

function parseStatus(chunks: Uint8Array[]): KubeStatus | null {
  if (chunks.length === 0) return null;
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  const text = new TextDecoder().decode(joined);
  try {
    return JSON.parse(text) as KubeStatus;
  } catch {
    return { status: 'Failure', message: text };
  }
}
