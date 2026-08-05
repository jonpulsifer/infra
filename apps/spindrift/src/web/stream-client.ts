/**
 * Reconnecting browser clients for the two internal WebSocket purposes.
 *
 * Imports from `./stream-path.ts` rather than `./streams.ts` — the paths and
 * message types are the only edge this file needs into the streaming
 * transport, and `streams.ts` pulls in `db/schema.ts`, `db/notify.ts`, and
 * `drizzle-orm` as values. `test/web/client-bundle.test.ts` guards against
 * this file reaching those instead.
 *
 * A dropped socket used to retry every `retryMs` forever, silently — including
 * when the drop is a stream refusing the reconnect's own upgrade with a 401,
 * which is a session that expired mid-visit rather than a network blip. A
 * native `WebSocket` has no way to read that: a failed handshake fires
 * `onerror`/`onclose` with no status the browser will hand back, by spec, so
 * the two causes are indistinguishable from inside this file's own events.
 * What is distinguishable is `readSession()` — the same session read `app.tsx`
 * already uses to gate the whole product — so once a run of drops is long
 * enough that a network blip stops being the likely story, this asks that
 * instead of the socket. A `false` answer stops the loop and raises
 * {@link reportSessionExpired}; every other case backs off and keeps trying,
 * which is also what turns the retry from a flat interval into one that
 * actually eases off rather than hammering a link that is not coming back.
 */
import { readSession } from './auth-client.ts';
import { markReconnecting, markSettled } from './connection-status.ts';
import { reportSessionExpired } from './session-events.ts';
import {
  ATTEMPT_STREAM_PATH,
  type AttemptStreamMessage,
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
  /**
   * Overridable for tests. Defaults to asking the server whether this browser
   * is still signed in — network failure reads as "still signed in", because
   * an inconclusive answer is a reason to keep backing off, not a reason to
   * throw a live session away.
   */
  readonly checkSession?: () => Promise<boolean>;
}

/** How long a drop backs off before the reconnect that checks the session. */
const CONSECUTIVE_DROPS_BEFORE_SESSION_CHECK = 3;
/** A ceiling on the backoff, so "still gone" settles into a slow poll rather than a growing wait. */
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

/** Capped exponential backoff, not a flat interval — see the module header. */
function backoff(attempt: number, base: number): number {
  return Math.min(base * 2 ** (attempt - 1), MAX_RETRY_MS);
}

/**
 * What both `onclose` handlers below do with a drop, factored out so the two
 * streams cannot drift on how a drop is retried. `attempt` is this drop's
 * 1-based count since the last successful message.
 */
function scheduleReconnect(params: {
  readonly id: symbol;
  readonly options: SubscribeOptions;
  readonly attempt: number;
  readonly reconnect: () => void;
  readonly giveUp: () => void;
  readonly setRetry: (handle: ReturnType<typeof setTimeout>) => void;
}): void {
  const { id, options, attempt, reconnect, giveUp, setRetry } = params;
  markReconnecting(id);
  const delay = backoff(attempt, options.retryMs ?? 500);
  if (attempt < CONSECUTIVE_DROPS_BEFORE_SESSION_CHECK) {
    setRetry(setTimeout(reconnect, delay));
    return;
  }
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
    /** One run of a job, whose output is that run's rather than the tail (§17). */
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
      if (message.kind === 'stream') cursor = message.cursor;
      attempts = 0;
      markSettled(id);
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
