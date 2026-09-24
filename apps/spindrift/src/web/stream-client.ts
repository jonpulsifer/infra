/**
 * Reconnecting browser clients for the WebSocket streams. Paths and message
 * types come from `./stream-path.ts`, since `streams.ts` pulls in the database.
 */
import { readSession } from './auth-client.ts';
import { markReconnecting, markSettled } from './connection-status.ts';
import { reportSessionExpired } from './session-events.ts';
import {
  ATTEMPT_STREAM_PATH,
  type AttemptStreamMessage,
  FUNCTION_LOG_STREAM_PATH,
  type FunctionLogStreamMessage,
  RUNTIME_STREAM_PATH,
  type RuntimeStreamMessage,
} from './stream-path.ts';

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
  /** The default treats a network failure as signed in and keeps retrying. */
  readonly checkSession?: () => Promise<boolean>;
}

/** The consecutive drop at which a reconnect first checks the session. */
const CONSECUTIVE_DROPS_BEFORE_SESSION_CHECK = 3;
/** Caps the backoff, so a long outage settles into a slow poll. */
const MAX_RETRY_MS = 8_000;

const browserSocket: SocketFactory = (url) =>
  new WebSocket(url) as BrowserSocket;

async function stillSignedIn(): Promise<boolean> {
  try {
    return (await readSession()).principal !== null;
  } catch {
    return true;
  }
}

function backoff(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_RETRY_MS);
}

/** `attempt` counts drops from 1 since the last healthy message. */
function scheduleReconnect(params: {
  readonly id: symbol;
  readonly options: SubscribeOptions;
  readonly attempt: number;
  readonly reconnect: () => void;
  readonly giveUp: () => void;
  readonly setRetry: (handle: ReturnType<typeof setTimeout>) => void;
}): void {
  const { id, options, attempt, reconnect, giveUp, setRetry } = params;
  // The banner waits for a second drop: one that reconnects inside its backoff
  // is a blip.
  if (attempt > 1) markReconnecting(id);
  const delay = backoff(attempt, options.retryMs ?? 500);
  if (attempt < CONSECUTIVE_DROPS_BEFORE_SESSION_CHECK) {
    setRetry(setTimeout(reconnect, delay));
    return;
  }
  // A failed handshake exposes no status, so a 401 shows only in the session.
  const checkSession = options.checkSession ?? stillSignedIn;
  setRetry(
    setTimeout(() => {
      void checkSession().then((signedIn) => {
        if (signedIn) {
          reconnect();
          return;
        }
        giveUp();
        markSettled(id);
        reportSessionExpired();
      });
    }, delay),
  );
}

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
  let attempts = 0;
  const id = Symbol('attempt-stream');
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
      attempts = 0;
      markSettled(id);
      onMessage(message);
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = null;
      if (stopped || terminal) return;
      attempts += 1;
      scheduleReconnect({
        id,
        options,
        attempt: attempts,
        reconnect: connect,
        giveUp: () => {
          stopped = true;
        },
        setRetry: (handle) => {
          retry = handle;
        },
      });
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    markSettled(id);
    socket?.close();
  };
}

export function subscribeRuntime(
  input: {
    readonly componentId: string;
    readonly targetId: string;
    /** A job run to stream in place of the live tail. */
    readonly execution?: string;
  },
  onMessage: (message: RuntimeStreamMessage) => void,
  options: SubscribeOptions = {},
): () => void {
  let cursor: string | null = null;
  let stopped = false;
  let socket: BrowserSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const id = Symbol('runtime-stream');
  const createSocket = options.createSocket ?? browserSocket;

  const connect = () => {
    if (stopped) return;
    const query = new URLSearchParams({
      componentId: input.componentId,
      targetId: input.targetId,
    });
    if (input.execution !== undefined) query.set('execution', input.execution);
    if (cursor !== null) query.set('after', cursor);
    socket = createSocket(streamUrl(`${RUNTIME_STREAM_PATH}?${query}`));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as RuntimeStreamMessage;
      // Only output proves the socket healthy: the server closes after the
      // other kinds, and resetting on those would reconnect at full speed.
      if (message.kind === 'stream') {
        cursor = message.cursor;
        attempts = 0;
        markSettled(id);
      }
      // Nothing runs on that Target. The screen's own re-read notices a change.
      if (message.kind === 'none') {
        stopped = true;
        markSettled(id);
      }
      onMessage(message);
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      attempts += 1;
      scheduleReconnect({
        id,
        options,
        attempt: attempts,
        reconnect: connect,
        giveUp: () => {
          stopped = true;
        },
        setRetry: (handle) => {
          retry = handle;
        },
      });
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    markSettled(id);
    socket?.close();
  };
}

/** No cursor: a reconnect reopens the tail from now, skipping the drop. */
export function subscribeFunctionLog(
  input: { readonly name: string },
  onMessage: (message: FunctionLogStreamMessage) => void,
  options: SubscribeOptions = {},
): () => void {
  let stopped = false;
  let socket: BrowserSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  const id = Symbol('function-log-stream');
  const createSocket = options.createSocket ?? browserSocket;

  const connect = () => {
    if (stopped) return;
    const query = new URLSearchParams({ name: input.name });
    socket = createSocket(streamUrl(`${FUNCTION_LOG_STREAM_PATH}?${query}`));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as FunctionLogStreamMessage;
      if (message.kind === 'function-log') {
        attempts = 0;
        markSettled(id);
      }
      onMessage(message);
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => {
      socket = null;
      if (stopped) return;
      attempts += 1;
      scheduleReconnect({
        id,
        options,
        attempt: attempts,
        reconnect: connect,
        giveUp: () => {
          stopped = true;
        },
        setRetry: (handle) => {
          retry = handle;
        },
      });
    };
  };

  connect();
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    markSettled(id);
    socket?.close();
  };
}

function streamUrl(path: string): string {
  if (typeof location === 'undefined') return `ws://spindrift.invalid${path}`;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}
