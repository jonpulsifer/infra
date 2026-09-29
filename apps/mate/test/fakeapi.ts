/**
 * An in-process apiserver: the Sandbox REST shape mate uses, pods behind the
 * controller's `status.selector`, and a `pods/exec` WebSocket that speaks
 * `v4.channel.k8s.io` framing. In hands mode an exec of the mate-hands binary
 * runs the real daemon; any other command is a one-shot shell.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { HANDS_BINARY } from '../src/hands.ts';
import type { KubeConfig } from '../src/kube.ts';

const DAEMON = Bun.resolveSync('@repo/mate-hands/main', import.meta.dir);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const STDIN = 0;
export const STDOUT = 1;
export const STDERR = 2;
export const STATUS = 3;

export function frame(channel: number, text: string | Uint8Array): Uint8Array {
  const body = typeof text === 'string' ? encoder.encode(text) : text;
  const out = new Uint8Array(body.length + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
}

/** Where every fake pod keeps the checkout, the agent's home and the daemon's ledger. */
export interface FakeHands {
  workspace: string;
  /** The daemon's `$HOME`, where credentials land. */
  home: string;
  /** Each pod's daemons keep their ledger under `<stateRoot>/<pod>`. */
  stateRoot: string;
}

/** What the kubelet reports for an exit code. */
function exitStatus(code: number): unknown {
  return code === 0
    ? { status: 'Success' }
    : {
        status: 'Failure',
        reason: 'NonZeroExitCode',
        message: `command terminated with non-zero exit code: exit status ${code}`,
        details: { causes: [{ reason: 'ExitCode', message: String(code) }] },
      };
}

export interface ExecRecord {
  pod: string;
  container: string;
  command: string[];
  protocol: string | null;
  authorization: string | null;
  stdin: string[];
  /** Set when the client closes: proof the harness's stdin was never half-closed. */
  clientClosed: boolean;
}

type Daemon = Subprocess<'pipe', 'pipe', 'pipe'>;

interface SocketData {
  exec: ExecRecord;
  buffer: string;
  daemon: Daemon | null;
  /** Answers `hello` for a protocol mate no longer speaks. */
  old: boolean;
}

type Json = Record<string, unknown>;

interface Watcher {
  push(event: string, object: Json): void;
}

function status(code: number, message: string, reason: string): Response {
  return Response.json(
    {
      kind: 'Status',
      apiVersion: 'v1',
      status: 'Failure',
      code,
      message,
      reason,
    },
    { status: code },
  );
}

function matches(object: Json, labelSelector: string | null): boolean {
  if (!labelSelector) return true;
  const labels = ((object.metadata as Json).labels ?? {}) as Record<
    string,
    string
  >;
  return labelSelector
    .split(',')
    .filter(Boolean)
    .every((term) => {
      const [key, value] = term.split('=');
      return key !== undefined && labels[key] === value;
    });
}

function named(object: Json, fieldSelector: string | null): boolean {
  if (!fieldSelector) return true;
  const want = fieldSelector.replace('metadata.name=', '');
  return (object.metadata as Json).name === want;
}

function merge(into: Json, patch: Json): Json {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete into[key];
    } else if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof into[key] === 'object' &&
      into[key] !== null &&
      !Array.isArray(into[key])
    ) {
      merge(into[key] as Json, value as Json);
    } else {
      into[key] = value;
    }
  }
  return into;
}

export interface Patched {
  name: string;
  contentType: string | null;
  query: string;
  body: Json;
}

export class FakeKube {
  readonly sandboxes = new Map<string, Json>();
  readonly pods = new Map<string, Json>();
  readonly secrets = new Map<string, Json>();
  /** Without hands: what `printf … > path` wrote and `cat path` reads. */
  readonly files = new Map<string, string>();
  readonly execs: ExecRecord[] = [];
  readonly patches: Patched[] = [];
  readonly requests: { method: string; path: string; query: string }[] = [];
  /** Every mate-hands daemon started, by pod. */
  readonly daemons = new Map<string, Daemon[]>();
  /** Fails every mate-hands exec with this status, as an image without the binary does. */
  handsFails: string | null = null;
  /** mate-hands answers `hello` for protocol 1. */
  oldHands = false;
  /** Refuses every mate-hands exec before it opens, as a missing RBAC rule does. */
  refuseHands = false;
  /** When false, a minted Sandbox stays not-Ready until `markReady` is called. */
  readyOnCreate = true;
  /** Answers every PATCH 403, the way a Role without `patch` does. */
  patchFails = false;
  /** Holds every Sandbox PATCH this long, as a slow apiserver does. */
  patchDelayMs = 0;
  /** Answers a Secret PATCH 403 while every other patch still lands. */
  secretPatchFails = false;
  /** This many Secret reads are answered, then the object moves on, as another writer would move it. */
  secretMovesAfterRead = 0;
  /** Answers every DELETE 500. */
  deleteFails = false;
  /** Fails every one-shot exec with this message. */
  commandFails: string | null = null;
  /** Fails only the one-shot execs that write files, so a read still answers. */
  writeFails: string | null = null;
  /** Refuses every TokenRequest 403 with this message, as a missing RBAC rule does. */
  tokenRequestFails: string | null = null;
  readonly tokenRequests: {
    account: string;
    expirationSeconds: number;
    audiences: string[];
  }[] = [];
  private minted = 0;
  readonly namespace = 'mate';

  private readonly server: Server<SocketData>;
  private readonly sandboxWatchers = new Set<Watcher>();
  private readonly podWatchers = new Set<Watcher>();
  private revision = 1;
  private serial = 0;

  constructor(private readonly opts: { hands?: FakeHands } = {}) {
    const fake = this;
    this.server = Bun.serve<SocketData>({
      // Bun's fetch resolves AAAA first with no fallback, so bind IPv4 loopback.
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 60,
      fetch(request, server) {
        return fake.route(request, server);
      },
      websocket: {
        open(ws) {
          if (ws.data.exec.command[0] === HANDS_BINARY) {
            fake.startHands(ws);
            return;
          }
          // Any other command is one-shot: it exits and the stream closes.
          const said =
            fake.commandFails ??
            (ws.data.exec.command.some((word) => word.includes('printf %s'))
              ? fake.writeFails
              : null);
          const out = said ? '' : fake.shell(ws.data.exec.command);
          if (out) ws.send(frame(STDOUT, out));
          ws.send(
            frame(
              STATUS,
              JSON.stringify(
                said
                  ? { status: 'Failure', message: said }
                  : { status: 'Success' },
              ),
            ),
          );
          ws.close(1000, 'command completed');
        },
        message(ws, message) {
          fake.onStdin(ws, message);
        },
        // The daemon keeps running: a pods/exec stream to kata delivers no EOF.
        close(ws) {
          ws.data.exec.clientClosed = true;
        },
      },
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  config(): KubeConfig {
    return {
      server: this.url,
      namespace: this.namespace,
      credentials: async () => ({ token: 'fake-token' }),
    };
  }

  /** Stops the server and every daemon, which kills what each started. */
  stop(): void {
    this.server.stop(true);
    for (const daemons of this.daemons.values()) {
      for (const daemon of daemons) {
        daemon.kill('SIGTERM');
        // A test may have left it stopped.
        daemon.kill('SIGCONT');
      }
    }
  }

  /** `stop`, then waits for every daemon to exit. */
  async close(): Promise<void> {
    this.stop();
    await Promise.all(
      [...this.daemons.values()].flat().map((daemon) => daemon.exited),
    );
  }

  /** The mate-hands execs, oldest first. */
  get handsExecs(): ExecRecord[] {
    return this.execs.filter((e) => e.command[0] === HANDS_BINARY);
  }

  get lastExec(): ExecRecord | undefined {
    return this.execs.at(-1);
  }

  markReady(name: string): void {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) throw new Error(`no sandbox ${name}`);
    const meta = sandbox.metadata as Json;
    sandbox.status = {
      conditions: [{ type: 'Ready', status: 'True', reason: 'SandboxReady' }],
      selector: `agents.x-k8s.io/sandbox-name-hash=${meta.name}`,
      podIPs: ['10.42.0.9'],
      nodeName: 'retrofit',
    };
    this.addPod(name, meta.uid as string);
    this.bump(sandbox);
    this.emit(this.sandboxWatchers, 'MODIFIED', sandbox);
  }

  /** Marks a Sandbox terminating without removing it, the way a finalizer does. */
  terminating(name: string): void {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) throw new Error(`no sandbox ${name}`);
    (sandbox.metadata as Json).deletionTimestamp = new Date().toISOString();
    this.bump(sandbox);
    this.emit(this.sandboxWatchers, 'MODIFIED', sandbox);
  }

  markNotReady(name: string): void {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) throw new Error(`no sandbox ${name}`);
    (sandbox.status as Json).conditions = [
      { type: 'Ready', status: 'False', reason: 'PodNotRunning' },
    ];
    this.bump(sandbox);
    this.emit(this.sandboxWatchers, 'MODIFIED', sandbox);
  }

  /** Deletes the pod under a live Sandbox, as a node eviction would, and every process in it. */
  killPod(name: string): void {
    for (const daemon of this.daemons.get(name) ?? []) daemon.kill('SIGTERM');
    const pod = this.pods.get(name);
    if (!pod) return;
    this.pods.delete(name);
    this.emit(this.podWatchers, 'DELETED', pod);
  }

  private addPod(name: string, uid: string): void {
    const pod: Json = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        namespace: this.namespace,
        labels: { 'agents.x-k8s.io/sandbox-name-hash': name },
        uid: `pod-uid-${++this.serial}`,
        ownerReferences: [{ kind: 'Sandbox', name, uid }],
        resourceVersion: String(++this.revision),
      },
      spec: {},
      status: { phase: 'Running' },
    };
    this.pods.set(name, pod);
    this.emit(this.podWatchers, 'ADDED', pod);
  }

  /** A Secret as the apiserver holds it: `data` values base64. */
  putSecret(name: string, data: Record<string, string>): void {
    const secret: Json = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace: this.namespace },
      type: 'Opaque',
      data: Object.fromEntries(
        Object.entries(data).map(([key, value]) => [
          key,
          Buffer.from(value).toString('base64'),
        ]),
      ),
    };
    this.bump(secret);
    this.secrets.set(name, secret);
  }

  secretRevision(name: string): string {
    const secret = this.secrets.get(name);
    if (!secret) throw new Error(`no secret ${name}`);
    return (secret.metadata as Json).resourceVersion as string;
  }

  /** One `data` value, decoded; `undefined` when the Secret or key is absent. */
  secretValue(name: string, key: string): string | undefined {
    const data = (this.secrets.get(name)?.data ?? {}) as Record<string, string>;
    const raw = data[key];
    return raw === undefined
      ? undefined
      : Buffer.from(raw, 'base64').toString('utf8');
  }

  // Enough of `sh -c` for the one-shot scripts mate runs: every
  // `printf %s "$n" > path` stores an argument, and `cat path` or `head -c n
  // path` reads one back; an absent path reads as nothing. With hands they are
  // real files, where the daemon reads and writes them too.
  private shell(command: string[]): string {
    const [shell, flag, script, ...argv] = command;
    if (shell !== '/bin/sh' || flag !== '-c' || !script) return '';
    const secret = script.includes('umask 077');
    for (const [, index, path] of script.matchAll(
      /printf %s "\$(\d+)" > ([^\s;]+)/g,
    )) {
      this.put(path as string, argv[Number(index)] ?? '', secret);
    }
    const read = /(?:cat|head -c (\d+)) ([^\s;]+)/.exec(script);
    if (!read) return '';
    const text = this.take(read[2] as string);
    return read[1] ? text.slice(0, Number(read[1])) : text;
  }

  private put(path: string, content: string, secret: boolean): void {
    if (!this.opts.hands) {
      this.files.set(path, content);
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: secret ? 0o600 : 0o644 });
  }

  private take(path: string): string {
    if (!this.opts.hands) return this.files.get(path) ?? '';
    return existsSync(path) && statSync(path).isFile()
      ? readFileSync(path, 'utf8')
      : '';
  }

  /**
   * The real daemon, on the checkout and home the test gave, under a
   * permissive umask so the modes it sets are its own doing.
   */
  private startHands(ws: ServerWebSocket<SocketData>): void {
    const { exec } = ws.data;
    const hands = this.opts.hands;
    const refused = hands
      ? this.handsFails
      : 'exec: "mate-hands": executable file not found in $PATH';
    if (refused) {
      ws.send(
        frame(STATUS, JSON.stringify({ status: 'Failure', message: refused })),
      );
      ws.close(1000, 'command failed');
      return;
    }
    if (this.oldHands) {
      ws.data.old = true;
      return;
    }
    const args = exec.command.slice(1);
    const cwd = args.indexOf('--cwd');
    if (cwd >= 0) args[cwd + 1] = hands?.workspace ?? '';
    const daemon: Daemon = Bun.spawn(
      [
        '/bin/sh',
        '-c',
        'umask 000; exec "$@"',
        'mate-hands',
        process.execPath,
        DAEMON,
        ...args,
        '--state-dir',
        join(hands?.stateRoot ?? '', exec.pod),
      ],
      {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          HOME: hands?.home ?? '',
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        },
      },
    );
    ws.data.daemon = daemon;
    this.daemons.set(exec.pod, [...(this.daemons.get(exec.pod) ?? []), daemon]);
    const send = (bytes: Uint8Array) => {
      try {
        ws.send(bytes);
      } catch {}
    };
    const pipe = async (from: ReadableStream<Uint8Array>, channel: number) => {
      const reader = from.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        send(frame(channel, value));
      }
    };
    const piped = Promise.all([
      pipe(daemon.stdout, STDOUT),
      pipe(daemon.stderr, STDERR),
    ]);
    void daemon.exited.then(async (code) => {
      await piped.catch(() => {});
      if (exec.clientClosed) return;
      send(frame(STATUS, JSON.stringify(exitStatus(code))));
      try {
        ws.close(1000, 'command exited');
      } catch {}
    });
  }

  private answerOld(ws: ServerWebSocket<SocketData>, line: string): void {
    const request = JSON.parse(line) as Json;
    if (request.method !== 'hello') return;
    const { command } = ws.data.exec;
    const epoch = Number(command[command.indexOf('--epoch') + 1]);
    ws.send(
      frame(
        STDOUT,
        `${JSON.stringify({ id: request.id, result: { protocol: 1, epoch } })}\n`,
      ),
    );
  }

  private bump(object: Json): void {
    (object.metadata as Json).resourceVersion = String(++this.revision);
  }

  private emit(watchers: Set<Watcher>, type: string, object: Json): void {
    for (const watcher of watchers) watcher.push(type, object);
  }

  /** Records the requested `expirationSeconds`, so a test can check a turn cannot outlive its token. */
  private async tokenRequest(
    request: Request,
    account: string,
  ): Promise<Response> {
    if (this.tokenRequestFails) {
      return status(403, this.tokenRequestFails, 'Forbidden');
    }
    const body = (await request.json()) as {
      spec?: { expirationSeconds?: number; audiences?: string[] };
    };
    this.tokenRequests.push({
      account,
      expirationSeconds: body.spec?.expirationSeconds ?? 0,
      audiences: body.spec?.audiences ?? [],
    });
    this.minted += 1;
    return Response.json({
      apiVersion: 'authentication.k8s.io/v1',
      kind: 'TokenRequest',
      status: { token: `sa-token-${this.minted}` },
    });
  }

  private route(
    request: Request,
    server: Server<SocketData>,
  ): Response | Promise<Response> | undefined {
    const url = new URL(request.url);
    const path = url.pathname;
    this.requests.push({
      method: request.method,
      path,
      query: url.searchParams.toString(),
    });
    const sandboxes = `/apis/agents.x-k8s.io/v1beta1/namespaces/${this.namespace}/sandboxes`;
    const pods = `/api/v1/namespaces/${this.namespace}/pods`;

    if (path.endsWith('/exec')) return this.upgrade(request, server, url);
    if (path === sandboxes) {
      if (request.method === 'POST') return this.create(request);
      return this.list(this.sandboxes, this.sandboxWatchers, url);
    }
    if (path.startsWith(`${sandboxes}/`)) {
      return this.one(request, path.slice(sandboxes.length + 1), url);
    }
    if (path === pods) return this.list(this.pods, this.podWatchers, url);
    const secrets = `/api/v1/namespaces/${this.namespace}/secrets/`;
    if (path.startsWith(secrets)) {
      return this.secret(request, path.slice(secrets.length), url);
    }
    const token = /\/serviceaccounts\/([^/]+)\/token$/.exec(path);
    if (token && request.method === 'POST') {
      return this.tokenRequest(request, token[1] as string);
    }
    return status(404, `no route ${path}`, 'NotFound');
  }

  private async create(request: Request): Promise<Response> {
    const object = (await request.json()) as Json;
    const meta = object.metadata as Json;
    const name = meta.name as string;
    if (this.sandboxes.has(name)) {
      return status(409, `sandboxes "${name}" already exists`, 'AlreadyExists');
    }
    meta.uid = `uid-${++this.serial}`;
    meta.namespace = this.namespace;
    this.bump(object);
    this.sandboxes.set(name, object);
    this.emit(this.sandboxWatchers, 'ADDED', object);
    if (this.readyOnCreate) this.markReady(name);
    return Response.json(this.sandboxes.get(name), { status: 201 });
  }

  private async secret(
    request: Request,
    name: string,
    url: URL,
  ): Promise<Response> {
    const secret = this.secrets.get(name);
    if (!secret) return status(404, `secrets "${name}" not found`, 'NotFound');
    if (request.method === 'PATCH') {
      if (this.patchFails || this.secretPatchFails) {
        return status(403, `secrets "${name}" is forbidden`, 'Forbidden');
      }
      const body = (await request.json()) as Json;
      this.patches.push({
        name,
        contentType: request.headers.get('content-type'),
        query: url.searchParams.toString(),
        body,
      });
      const want = ((body.metadata ?? {}) as Json).resourceVersion;
      if (want && want !== (secret.metadata as Json).resourceVersion) {
        return status(
          409,
          `Operation cannot be fulfilled on secrets "${name}": the object has been modified`,
          'Conflict',
        );
      }
      merge(secret, body);
      this.bump(secret);
      return Response.json(secret);
    }
    const served = Response.json(secret);
    if (this.secretMovesAfterRead > 0) {
      this.secretMovesAfterRead -= 1;
      this.bump(secret);
    }
    return served;
  }

  private async one(
    request: Request,
    name: string,
    url: URL,
  ): Promise<Response> {
    const sandbox = this.sandboxes.get(name);
    if (request.method === 'DELETE') {
      if (!sandbox) return status(404, `no sandbox ${name}`, 'NotFound');
      if (this.deleteFails) {
        return status(500, `sandboxes "${name}" could not be deleted`, 'Error');
      }
      this.sandboxes.delete(name);
      this.killPod(name);
      this.emit(this.sandboxWatchers, 'DELETED', sandbox);
      return Response.json({ kind: 'Status', status: 'Success' });
    }
    if (!sandbox) return status(404, `no sandbox ${name}`, 'NotFound');
    if (request.method === 'PATCH') {
      if (this.patchDelayMs) await Bun.sleep(this.patchDelayMs);
      if (this.patchFails) {
        return status(403, `sandboxes "${name}" is forbidden`, 'Forbidden');
      }
      const body = (await request.json()) as Json;
      this.patches.push({
        name,
        contentType: request.headers.get('content-type'),
        query: url.searchParams.toString(),
        body,
      });
      // A merge patch carrying a stale resourceVersion is a 409, as on the apiserver.
      const want = ((body.metadata ?? {}) as Json).resourceVersion;
      if (want && want !== (sandbox.metadata as Json).resourceVersion) {
        return status(
          409,
          `Operation cannot be fulfilled on sandboxes "${name}": the object has been modified`,
          'Conflict',
        );
      }
      merge(sandbox, body);
      this.bump(sandbox);
      this.emit(this.sandboxWatchers, 'MODIFIED', sandbox);
    }
    return Response.json(sandbox);
  }

  private list(
    store: Map<string, Json>,
    watchers: Set<Watcher>,
    url: URL,
  ): Response {
    const labelSelector = url.searchParams.get('labelSelector');
    const fieldSelector = url.searchParams.get('fieldSelector');
    const keep = (object: Json) =>
      matches(object, labelSelector) && named(object, fieldSelector);
    if (url.searchParams.get('watch') !== 'true') {
      return Response.json({
        metadata: { resourceVersion: String(this.revision) },
        items: [...store.values()].filter(keep),
      });
    }
    const seconds = Number(url.searchParams.get('timeoutSeconds') ?? '10');
    let watcher: Watcher;
    let open = true;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const finish = () => {
          if (!open) return;
          open = false;
          watchers.delete(watcher);
          controller.close();
        };
        watcher = {
          push: (type, object) => {
            if (!open || !keep(object)) return;
            controller.enqueue(
              encoder.encode(`${JSON.stringify({ type, object })}\n`),
            );
          },
        };
        watchers.add(watcher);
        setTimeout(finish, seconds * 1000).unref?.();
      },
      // The runtime has closed the stream; the timer above must not close it
      // again, or it throws into whatever test is running by then.
      cancel: () => {
        open = false;
        watchers.delete(watcher);
      },
    });
    return new Response(body, {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private upgrade(
    request: Request,
    server: Server<SocketData>,
    url: URL,
  ): Response | undefined {
    const parts = url.pathname.split('/');
    const pod = parts[parts.length - 2] ?? '';
    const protocol = request.headers.get('sec-websocket-protocol');
    const exec: ExecRecord = {
      pod,
      container: url.searchParams.get('container') ?? '',
      command: url.searchParams.getAll('command'),
      protocol,
      authorization: request.headers.get('authorization'),
      stdin: [],
      clientClosed: false,
    };
    if (this.refuseHands && exec.command[0] === HANDS_BINARY) {
      return status(403, `pods "${pod}" is forbidden`, 'Forbidden');
    }
    this.execs.push(exec);
    const upgraded = server.upgrade(request, {
      data: { exec, buffer: '', daemon: null, old: false },
      headers: protocol ? { 'Sec-WebSocket-Protocol': protocol } : undefined,
    });
    return upgraded
      ? undefined
      : status(400, 'expected a websocket', 'BadRequest');
  }

  private onStdin(
    ws: ServerWebSocket<SocketData>,
    message: string | Buffer,
  ): void {
    const bytes =
      typeof message === 'string' ? encoder.encode(message) : message;
    if (bytes.length === 0 || bytes[0] !== STDIN) return;
    const payload = bytes.subarray(1);
    const { daemon } = ws.data;
    if (daemon) {
      daemon.stdin.write(payload);
      void daemon.stdin.flush();
    }
    ws.data.buffer += decoder.decode(payload);
    for (;;) {
      const at = ws.data.buffer.indexOf('\n');
      if (at < 0) break;
      const line = ws.data.buffer.slice(0, at).trim();
      ws.data.buffer = ws.data.buffer.slice(at + 1);
      if (!line) continue;
      ws.data.exec.stdin.push(line);
      if (ws.data.old) this.answerOld(ws, line);
    }
  }
}
