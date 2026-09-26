import type { Log } from '../log.ts';
import type {
  AriBridge,
  AriChannel,
  AriEndpoint,
  AriEvent,
} from './ari-types.ts';
import type { BoardConfig } from './config.ts';
import { parseMetrics } from './metrics.ts';
import type { BoardModel } from './model.ts';

/** The Stasis application the events socket registers; nothing routes to it. */
export const ARI_APP = 'switchboard';

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BUFFERED = 1_000;

export interface AriTimings {
  readonly pingMs: number;
  readonly pongTimeoutMs: number;
  readonly resyncMs: number;
  readonly metricsMs: number;
  readonly backoffMs: readonly number[];
  /** A socket open this long resets the backoff. */
  readonly stableMs: number;
}

export const DEFAULT_TIMINGS: AriTimings = {
  pingMs: 30_000,
  pongTimeoutMs: 10_000,
  resyncMs: 60_000,
  metricsMs: 15_000,
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000],
  stableMs: 30_000,
};

type SocketCtor = new (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

export interface AriClientOptions {
  readonly config: Pick<BoardConfig, 'ariUrl' | 'ariUser' | 'ariPassword'>;
  readonly model: BoardModel;
  readonly log: Log;
  readonly timings?: Partial<AriTimings>;
  /** Overridable for tests. */
  readonly WebSocket?: SocketCtor;
  readonly fetch?: typeof fetch;
}

class AriRequestError extends Error {
  constructor(readonly reason: 'unauthorized' | 'unreachable' | 'http-error') {
    super(`ari request failed: ${reason}`);
  }
}

/**
 * Keeps the model in step with Asterisk: one events socket subscribed to
 * everything, the channel list re-read on every connect and each minute, and
 * /metrics polled for what ARI does not carry. The credential goes in an
 * Authorization header on every request and the socket upgrade, never in a
 * URL, and no log line carries it.
 */
export class AriClient {
  private readonly timings: AriTimings;
  private readonly authorization: string;
  private readonly Socket: SocketCtor;
  private readonly fetch: typeof fetch;
  private socket: WebSocket | undefined;
  private attempt = 0;
  private lastReason: string | null = null;
  private stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private intervals = new Set<ReturnType<typeof setInterval>>();
  private connectionTimers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly opts: AriClientOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    const { ariUser, ariPassword } = opts.config;
    this.authorization = `Basic ${btoa(`${ariUser}:${ariPassword}`)}`;
    this.Socket = opts.WebSocket ?? (WebSocket as unknown as SocketCtor);
    this.fetch = opts.fetch ?? fetch;
  }

  start(): void {
    this.stopped = false;
    this.intervals.add(
      setInterval(() => void this.pollMetrics(), this.timings.metricsMs),
    );
    void this.pollMetrics();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    for (const i of this.intervals) clearInterval(i);
    this.clearConnectionTimers();
    this.timers.clear();
    this.intervals.clear();
    this.socket?.close();
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.config.ariUrl}${path}`, {
        headers: { authorization: this.authorization },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new AriRequestError('unreachable');
    }
    if (res.status === 401) throw new AriRequestError('unauthorized');
    if (!res.ok) throw new AriRequestError('http-error');
    return (await res.json()) as T;
  }

  private async pollMetrics(): Promise<void> {
    try {
      // /metrics is res_prometheus's, with no auth, so it gets no credential.
      const res = await this.fetch(`${this.opts.config.ariUrl}/metrics`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(String(res.status));
      this.opts.model.setMetrics(parseMetrics(await res.text()));
    } catch {
      this.opts.model.setMetrics(undefined);
    }
  }

  private async loadState(): Promise<void> {
    const since = this.opts.model.clock();
    const [channels, bridges, endpoints] = await Promise.all([
      this.get<AriChannel[]>('/ari/channels'),
      this.get<AriBridge[]>('/ari/bridges'),
      this.get<AriEndpoint[]>('/ari/endpoints'),
    ]);
    this.opts.model.load({ channels, bridges, endpoints }, since);
  }

  private clearConnectionTimers(): void {
    for (const t of this.connectionTimers) clearInterval(t);
    this.connectionTimers = [];
  }

  private connect(): void {
    if (this.stopped) return;
    const { model, log } = this.opts;
    model.setLink('connecting', this.lastReason);
    const base = this.opts.config.ariUrl.replace(/^http/, 'ws');
    const url = `${base}/ari/events?app=${ARI_APP}&subscribeAll=true`;
    const socket = new this.Socket(url, {
      headers: { authorization: this.authorization },
    });
    this.socket = socket;
    let opened = 0;
    let ready = false;
    let buffered: AriEvent[] = [];
    let awaitingPong: ReturnType<typeof setTimeout> | undefined;

    socket.onopen = () => {
      opened = Date.now();
      // Events that arrive while the lists load are applied after them, so a
      // call that starts mid-load is neither lost nor doubled.
      this.loadState()
        .then(() => {
          for (const event of buffered) model.apply(event);
          buffered = [];
          ready = true;
          this.lastReason = null;
          model.setLink('connected');
          log.info('ari connected', {
            calls: model.snapshot().calls.length,
          });
        })
        .catch((error: unknown) => {
          const reason =
            error instanceof AriRequestError ? error.reason : 'unreachable';
          log.warn('ari initial state failed', { reason });
          socket.close();
        });
      socket.addEventListener('pong', () => {
        clearTimeout(awaitingPong);
        awaitingPong = undefined;
      });
      this.connectionTimers.push(
        setInterval(() => {
          if (awaitingPong) return;
          awaitingPong = setTimeout(() => {
            log.warn('ari socket unresponsive');
            socket.terminate();
          }, this.timings.pongTimeoutMs);
          socket.ping();
        }, this.timings.pingMs),
        setInterval(() => {
          if (!ready) return;
          this.loadState().catch(() => {
            // The next ping or resync finds out whether the PBX is gone.
          });
        }, this.timings.resyncMs),
      );
    };

    socket.onmessage = (message: MessageEvent) => {
      let event: AriEvent;
      try {
        event = JSON.parse(String(message.data)) as AriEvent;
      } catch {
        return;
      }
      if (event.type === 'ApplicationReplaced') {
        log.warn('ari app replaced by another connection');
      }
      if (ready) model.apply(event);
      else if (buffered.length < MAX_BUFFERED) buffered.push(event);
    };

    socket.onclose = () => {
      clearTimeout(awaitingPong);
      this.clearConnectionTimers();
      if (this.socket === socket) this.socket = undefined;
      if (this.stopped) return;
      if (opened && Date.now() - opened >= this.timings.stableMs) {
        this.attempt = 0;
      }
      void this.retry(opened ? 'closed' : undefined);
    };
  }

  private async retry(known?: string): Promise<void> {
    const { model, log } = this.opts;
    // A failed upgrade reports no status, so a plain request says whether the
    // credential or the network is at fault.
    let reason = known;
    if (!reason) {
      try {
        await this.get('/ari/endpoints');
        reason = 'closed';
      } catch (error) {
        reason =
          error instanceof AriRequestError ? error.reason : 'unreachable';
      }
    }
    const steps = this.timings.backoffMs;
    const base = steps[Math.min(this.attempt, steps.length - 1)] ?? 30_000;
    this.attempt++;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.lastReason = reason;
    model.setLink('disconnected', reason);
    log.warn('ari disconnected', { reason, retryInMs: delay });
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.connect();
    }, delay);
    this.timers.add(timer);
  }
}
