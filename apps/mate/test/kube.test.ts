/**
 * The exec transport: the apiserver request, and `v4.channel.k8s.io` frames as
 * stdin, stdout, stderr and a close status.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Server, ServerWebSocket } from 'bun';
import {
  EXEC_PROTOCOL,
  type ExecStream,
  Kube,
  type KubeConfig,
} from '../src/kube.ts';
import { frame, STATUS, STDERR, STDOUT } from './fakeapi.ts';

const decoder = new TextDecoder();

interface Data {
  never: true;
}

/** A pods/exec endpoint the test drives frame by frame. */
class RawExec {
  readonly urls: URL[] = [];
  readonly headers: Headers[] = [];
  readonly stdin: Uint8Array[] = [];
  clientClosed = false;
  private socket: ServerWebSocket<Data> | null = null;
  private readonly server: Server<Data>;
  private opened: (() => void)[] = [];

  constructor() {
    const raw = this;
    this.server = Bun.serve<Data>({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 60,
      fetch(request, server) {
        const url = new URL(request.url);
        raw.urls.push(url);
        raw.headers.push(request.headers);
        const protocol = request.headers.get('sec-websocket-protocol');
        const upgraded = server.upgrade(request, {
          data: { never: true },
          headers: protocol
            ? { 'Sec-WebSocket-Protocol': protocol }
            : undefined,
        });
        return upgraded ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          raw.socket = ws;
          for (const resolve of raw.opened.splice(0)) resolve();
        },
        message(_ws, message) {
          raw.stdin.push(
            typeof message === 'string'
              ? new TextEncoder().encode(message)
              : new Uint8Array(message),
          );
        },
        close() {
          raw.clientClosed = true;
        },
      },
    });
  }

  get config(): KubeConfig {
    return {
      server: `http://127.0.0.1:${this.server.port}`,
      namespace: 'mate',
      credentials: async () => ({ token: 'fake-token' }),
    };
  }

  async ready(): Promise<ServerWebSocket<Data>> {
    if (this.socket) return this.socket;
    await new Promise<void>((resolve) => this.opened.push(resolve));
    return this.socket as unknown as ServerWebSocket<Data>;
  }

  send(channel: number, text: string): void {
    this.socket?.send(frame(channel, text));
  }

  sendBytes(channel: number, body: Uint8Array): void {
    const out = new Uint8Array(body.length + 1);
    out[0] = channel;
    out.set(body, 1);
    this.socket?.sendBinary(out);
  }

  hangUp(code = 1000, reason = 'done'): void {
    this.socket?.close(code, reason);
  }

  stop(): void {
    this.server.stop(true);
  }
}

async function readAll(stream: ExecStream): Promise<string> {
  const reader = stream.stdout.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return parts.map((part) => decoder.decode(part, { stream: true })).join('');
}

let raw: RawExec;
let kube: Kube;

beforeEach(() => {
  raw = new RawExec();
  kube = new Kube(raw.config);
});

afterEach(() => {
  raw.stop();
});

function open(): Promise<ExecStream> {
  return kube.exec({
    pod: 'mate-1',
    container: 'harness',
    command: ['opencode', 'acp', '--cwd', '/workspace'],
    onStderr: (text) => stderr.push(text),
  });
}

let stderr: string[] = [];
beforeEach(() => {
  stderr = [];
});

describe('exec', () => {
  test('asks the apiserver for a bidirectional v4 stream', async () => {
    const stream = await open();
    const url = raw.urls[0];
    expect(url?.pathname).toBe('/api/v1/namespaces/mate/pods/mate-1/exec');
    expect(url?.searchParams.get('container')).toBe('harness');
    expect(url?.searchParams.get('stdin')).toBe('true');
    expect(url?.searchParams.get('stdout')).toBe('true');
    expect(url?.searchParams.get('stderr')).toBe('true');
    expect(url?.searchParams.get('tty')).toBe('false');
    expect(url?.searchParams.getAll('command')).toEqual([
      'opencode',
      'acp',
      '--cwd',
      '/workspace',
    ]);
    expect(raw.headers[0]?.get('authorization')).toBe('Bearer fake-token');
    expect(raw.headers[0]?.get('sec-websocket-protocol')).toBe(EXEC_PROTOCOL);
    stream.close();
  });

  test('reassembles a line split across frames', async () => {
    const stream = await open();
    await raw.ready();
    raw.send(STDOUT, '{"jsonrpc":"2.0"');
    raw.send(STDOUT, ',"id":1}\n');
    raw.hangUp();
    expect(await readAll(stream)).toBe('{"jsonrpc":"2.0","id":1}\n');
  });

  test('carries a multi-byte character split across frames', async () => {
    const stream = await open();
    await raw.ready();
    const bytes = new TextEncoder().encode('thinking…');
    raw.sendBytes(STDOUT, bytes.subarray(0, bytes.length - 2));
    raw.sendBytes(STDOUT, bytes.subarray(bytes.length - 2));
    raw.hangUp();
    expect(await readAll(stream)).toBe('thinking…');
  });

  test('ignores a frame that is only a channel byte', async () => {
    const stream = await open();
    await raw.ready();
    raw.sendBytes(STDOUT, new Uint8Array(0));
    raw.send(STDOUT, 'after');
    raw.hangUp();
    expect(await readAll(stream)).toBe('after');
  });

  test('routes the stderr channel away from stdout', async () => {
    const stream = await open();
    await raw.ready();
    raw.send(STDERR, 'warn: model catalogue stale');
    raw.send(STDOUT, 'answer');
    raw.hangUp();
    expect(await readAll(stream)).toBe('answer');
    expect(stderr.join('')).toBe('warn: model catalogue stale');
  });

  test('parses the error channel into the close status', async () => {
    const stream = await open();
    await raw.ready();
    raw.send(
      STATUS,
      JSON.stringify({
        status: 'Failure',
        message: 'command terminated with exit code 1',
        reason: 'NonZeroExitCode',
      }),
    );
    raw.hangUp(1000, 'stream ended');
    const close = await stream.closed;
    expect(close.status?.status).toBe('Failure');
    expect(close.status?.reason).toBe('NonZeroExitCode');
    expect(close.code).toBe(1000);
  });

  test('a close mid-stream ends stdout and resolves closed', async () => {
    const stream = await open();
    await raw.ready();
    raw.send(STDOUT, 'half an ans');
    raw.hangUp(1011, 'apiserver went away');
    expect(await readAll(stream)).toBe('half an ans');
    const close = await stream.closed;
    expect(close.code).toBe(1011);
    expect(close.reason).toBe('apiserver went away');
    expect(close.status).toBeNull();
  });

  test('frames stdin on channel 0 and leaves it open when the writer closes', async () => {
    const stream = await open();
    await raw.ready();
    const writer = stream.stdin.getWriter();
    await writer.write(new TextEncoder().encode('{"id":1}\n'));
    await writer.close();
    await Bun.sleep(25);
    expect(raw.stdin.length).toBe(1);
    expect(raw.stdin[0]?.[0]).toBe(0);
    expect(decoder.decode(raw.stdin[0]?.subarray(1))).toBe('{"id":1}\n');
    // kata-clh stops writing stdout once stdin reaches EOF, so closing the
    // writable must never close the socket.
    expect(raw.clientClosed).toBe(false);
    raw.send(STDOUT, 'still talking');
    raw.hangUp();
    expect(await readAll(stream)).toBe('still talking');
  });

  test('a refused upgrade explains itself with the plain GET', async () => {
    // A 403 reaches Bun's WebSocket as a bare close, so the reason comes from
    // a plain HTTP GET.
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () =>
        Response.json(
          {
            kind: 'Status',
            status: 'Failure',
            code: 403,
            message:
              'pods "mate-1" is forbidden: User "system:serviceaccount:mate:mate" cannot get resource "pods/exec"',
          },
          { status: 403 },
        ),
    });
    const denied = new Kube({
      server: `http://127.0.0.1:${server.port}`,
      namespace: 'mate',
      credentials: async () => ({ token: 'fake-token' }),
    });
    try {
      await expect(
        denied.exec({
          pod: 'mate-1',
          container: 'harness',
          command: ['true'],
          timeoutMs: 5000,
        }),
      ).rejects.toThrow(/exec refused.*403.*pods\/exec/s);
    } finally {
      server.stop(true);
    }
  });
});
