/** Reconnecting browser clients for the two internal WebSocket purposes. */
import {
  ATTEMPT_STREAM_PATH,
  type AttemptStreamMessage,
  RUNTIME_STREAM_PATH,
  type RuntimeStreamMessage,
} from './streams.ts';

export interface BrowserSocket {
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type SocketFactory = (url: string) => BrowserSocket;

interface SubscribeOptions {
  readonly createSocket?: SocketFactory;
  readonly retryMs?: number;
}

const browserSocket: SocketFactory = (url) =>
  new WebSocket(url) as BrowserSocket;

export function subscribeAttempt(
  input: { readonly buildId: number; readonly deployId?: number },
  onMessage: (message: AttemptStreamMessage) => void,
  options: SubscribeOptions = {},
): () => void {
  let cursor: number | null = null;
  let stopped = false;
  let terminal = false;
  let socket: BrowserSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const createSocket = options.createSocket ?? browserSocket;

  const connect = () => {
    if (stopped || terminal) return;
    const query = new URLSearchParams({ buildId: String(input.buildId) });
    if (input.deployId !== undefined) {
      query.set('deployId', String(input.deployId));
    }
    if (cursor !== null) query.set('after', String(cursor));
    socket = createSocket(streamUrl(`${ATTEMPT_STREAM_PATH}?${query}`));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as AttemptStreamMessage;
      if (message.kind !== 'attempt') return;
      cursor = message.cursor;
      terminal = message.terminal;
      onMessage(message);
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = null;
      if (!stopped && !terminal) {
        retry = setTimeout(connect, options.retryMs ?? 500);
      }
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    socket?.close();
  };
}

export function subscribeRuntime(
  input: { readonly componentId: string; readonly targetId: string },
  onMessage: (message: RuntimeStreamMessage) => void,
  options: SubscribeOptions = {},
): () => void {
  let cursor: string | null = null;
  let stopped = false;
  let socket: BrowserSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const createSocket = options.createSocket ?? browserSocket;

  const connect = () => {
    if (stopped) return;
    const query = new URLSearchParams({
      componentId: input.componentId,
      targetId: input.targetId,
    });
    if (cursor !== null) query.set('after', cursor);
    socket = createSocket(streamUrl(`${RUNTIME_STREAM_PATH}?${query}`));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as RuntimeStreamMessage;
      if (message.kind === 'stream') cursor = message.cursor;
      onMessage(message);
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = null;
      if (!stopped) retry = setTimeout(connect, options.retryMs ?? 500);
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    socket?.close();
  };
}

function streamUrl(path: string): string {
  if (typeof location === 'undefined') return `ws://spindrift.invalid${path}`;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}
