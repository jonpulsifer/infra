/**
 * An in-process apiserver: the Sandbox REST shape mate uses, pods behind the
 * controller's `status.selector`, and a `pods/exec` WebSocket that speaks
 * `v4.channel.k8s.io` framing to a scripted ACP agent.
 */
import type { Server, ServerWebSocket } from 'bun';
import type { KubeConfig } from '../src/kube.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const STDIN = 0;
export const STDOUT = 1;
export const STDERR = 2;
export const STATUS = 3;

export function frame(channel: number, text: string): Uint8Array {
  const body = encoder.encode(text);
  const out = new Uint8Array(body.length + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
}

export interface AgentScript {
  /** `session/load` answers with a JSON-RPC error, forcing the `session/new` fallback. */
  loadFails?: boolean;
  chunks?: string[];
  thinking?: boolean;
  tool?: string;
  cost?: number;
  /** One running session total per turn, as ACP reports cost. */
  costs?: number[];
  stopReason?: string;
  stderr?: string;
  /** Every outbound line is sent as two frames, so the reader must reassemble. */
  splitLines?: boolean;
  /** Closes the stream once this many chunks have gone out. */
  closeAfterChunk?: number;
  /** Sent on channel 3 before the close. */
  closeStatus?: unknown;
  chunkDelayMs?: number;
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

interface SocketData {
  exec: ExecRecord;
  script: AgentScript;
  buffer: string;
  cancelled: boolean;
  turns: number;
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
  body: Json;
}

export class FakeKube {
  readonly sandboxes = new Map<string, Json>();
  readonly pods = new Map<string, Json>();
  readonly execs: ExecRecord[] = [];
  readonly patches: Patched[] = [];
  /** Every request, so a test can pin what a path asks for and what it does not. */
  readonly requests: { method: string; path: string; query: string }[] = [];
  script: AgentScript = {};
  /** When false, a minted Sandbox stays not-Ready until `markReady` is called. */
  readyOnCreate = true;
  /** Answers every PATCH 403, the way a Role without `patch` does. */
  patchFails = false;
  /** Answers every DELETE 500, the way an apiserver having a bad day does. */
  deleteFails = false;
  /** Fails a one-shot command, which is how the refresh exec is made to lose. */
  commandFails: string | null = null;
  readonly namespace = 'mate';

  private readonly server: Server<SocketData>;
  private readonly sandboxWatchers = new Set<Watcher>();
  private readonly podWatchers = new Set<Watcher>();
  private revision = 1;
  private serial = 0;

  constructor() {
    const fake = this;
    this.server = Bun.serve<SocketData>({
      // Bun's fetch resolves AAAA first and does not fall back, so the loopback
      // address is spelled out rather than left to `localhost`.
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 60,
      fetch(request, server) {
        return fake.route(request, server);
      },
      websocket: {
        open(ws) {
          // Anything that is not the ACP harness is a one-shot command: it
          // exits and the apiserver closes the stream behind it.
          if (!ws.data.exec.command.includes('acp')) {
            const said = fake.commandFails;
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
          }
        },
        message(ws, message) {
          fake.onStdin(ws, message);
        },
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

  stop(): void {
    this.server.stop(true);
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

  /** Takes a Sandbox's Ready condition away, the way a pod going under does. */
  markNotReady(name: string): void {
    const sandbox = this.sandboxes.get(name);
    if (!sandbox) throw new Error(`no sandbox ${name}`);
    (sandbox.status as Json).conditions = [
      { type: 'Ready', status: 'False', reason: 'PodNotRunning' },
    ];
    this.bump(sandbox);
    this.emit(this.sandboxWatchers, 'MODIFIED', sandbox);
  }

  /** Deletes the pod out from under a live Sandbox, the way a node eviction would. */
  killPod(name: string): void {
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
        ownerReferences: [{ kind: 'Sandbox', name, uid }],
        resourceVersion: String(++this.revision),
      },
      spec: {},
      status: { phase: 'Running' },
    };
    this.pods.set(name, pod);
    this.emit(this.podWatchers, 'ADDED', pod);
  }

  private bump(object: Json): void {
    (object.metadata as Json).resourceVersion = String(++this.revision);
  }

  private emit(watchers: Set<Watcher>, type: string, object: Json): void {
    for (const watcher of watchers) watcher.push(type, object);
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
      return this.one(request, path.slice(sandboxes.length + 1));
    }
    if (path === pods) return this.list(this.pods, this.podWatchers, url);
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

  private async one(request: Request, name: string): Promise<Response> {
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
      if (this.patchFails) {
        return status(403, `sandboxes "${name}" is forbidden`, 'Forbidden');
      }
      const body = (await request.json()) as Json;
      this.patches.push({
        name,
        contentType: request.headers.get('content-type'),
        body,
      });
      // A merge patch carrying a resourceVersion is an update from that
      // revision, which is how two writers racing for one object are told
      // apart: the apiserver refuses the second.
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
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true;
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
      cancel: () => {
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
    this.execs.push(exec);
    const upgraded = server.upgrade(request, {
      data: {
        exec,
        script: this.script,
        buffer: '',
        cancelled: false,
        turns: 0,
      },
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
    ws.data.buffer += decoder.decode(bytes.subarray(1));
    for (;;) {
      const at = ws.data.buffer.indexOf('\n');
      if (at < 0) break;
      const line = ws.data.buffer.slice(0, at).trim();
      ws.data.buffer = ws.data.buffer.slice(at + 1);
      if (!line) continue;
      ws.data.exec.stdin.push(line);
      void this.dispatch(ws, JSON.parse(line) as Json);
    }
  }

  private send(ws: ServerWebSocket<SocketData>, message: Json): void {
    const line = `${JSON.stringify(message)}\n`;
    if (ws.data.script.splitLines && line.length > 8) {
      const at = Math.floor(line.length / 2);
      ws.send(frame(STDOUT, line.slice(0, at)));
      ws.send(frame(STDOUT, line.slice(at)));
      return;
    }
    ws.send(frame(STDOUT, line));
  }

  private reply(
    ws: ServerWebSocket<SocketData>,
    id: unknown,
    result: Json,
  ): void {
    this.send(ws, { jsonrpc: '2.0', id, result });
  }

  private notify(
    ws: ServerWebSocket<SocketData>,
    sessionId: string,
    update: Json,
  ): void {
    this.send(ws, {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  private hangUp(ws: ServerWebSocket<SocketData>): void {
    const { closeStatus } = ws.data.script;
    if (closeStatus) ws.send(frame(STATUS, JSON.stringify(closeStatus)));
    ws.close(1000, 'harness exited');
  }

  private async dispatch(
    ws: ServerWebSocket<SocketData>,
    message: Json,
  ): Promise<void> {
    const script = ws.data.script;
    const params = (message.params ?? {}) as Json;
    if (script.stderr) ws.send(frame(STDERR, script.stderr));
    switch (message.method) {
      case 'initialize':
        this.reply(ws, message.id, {
          protocolVersion: params.protocolVersion ?? 1,
          agentCapabilities: { loadSession: true },
        });
        return;
      case 'session/new':
        this.reply(ws, message.id, { sessionId: `ses-${++this.serial}` });
        return;
      case 'session/load':
        if (script.loadFails) {
          this.send(ws, {
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'no such session' },
          });
          return;
        }
        this.reply(ws, message.id, {});
        return;
      case 'session/cancel':
        ws.data.cancelled = true;
        return;
      case 'session/prompt':
        await this.runTurn(ws, message, params.sessionId as string);
        return;
      default:
        return;
    }
  }

  private async runTurn(
    ws: ServerWebSocket<SocketData>,
    message: Json,
    sessionId: string,
  ): Promise<void> {
    const script = ws.data.script;
    const turn = ws.data.turns++;
    if (script.thinking) {
      this.notify(ws, sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'weighing it up' },
      });
    }
    if (script.tool) {
      this.notify(ws, sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: script.tool,
        status: 'in_progress',
      });
    }
    let sent = 0;
    for (const chunk of script.chunks ?? ['hello from the harness']) {
      if (ws.data.cancelled) break;
      this.notify(ws, sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk },
      });
      sent += 1;
      if (script.closeAfterChunk === sent) {
        this.hangUp(ws);
        return;
      }
      if (script.chunkDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, script.chunkDelayMs),
        );
      }
    }
    if (script.tool) {
      this.notify(ws, sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
      });
    }
    const total = script.costs ? script.costs[turn] : script.cost;
    if (total !== undefined) {
      this.notify(ws, sessionId, {
        sessionUpdate: 'usage_update',
        used: 4096,
        size: 200_000,
        cost: { amount: total, currency: 'USD' },
      });
    }
    this.reply(ws, message.id, {
      stopReason: ws.data.cancelled
        ? 'cancelled'
        : (script.stopReason ?? 'end_turn'),
    });
  }
}
