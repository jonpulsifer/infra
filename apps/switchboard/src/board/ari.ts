import type { Log } from '../log.ts';
import type { AriBridge, AriChannel, AriEndpoint } from './ari-types.ts';
import type { BoardConfig } from './config.ts';
import { parseMetrics } from './metrics.ts';
import type { BoardModel } from './model.ts';

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Every request the board makes, and every one it may: the CiliumNetworkPolicy
 * pbx-ari admits these exact paths from the board, as GET, and refuses the
 * rest. ARI answers a GET of a channel variable by running any dialplan
 * function named in it, SET() included, so a read-only user is not read-only
 * and the path is the boundary.
 */
export const ARI_LISTS = [
  '/ari/channels',
  '/ari/bridges',
  '/ari/endpoints',
] as const;
export const METRICS_PATH = '/metrics';

type AriList = (typeof ARI_LISTS)[number];

export interface AriTimings {
  readonly pollMs: number;
  readonly metricsMs: number;
  /** The waits after one, two, … failed polls in a row. */
  readonly backoffMs: readonly number[];
}

export const DEFAULT_TIMINGS: AriTimings = {
  pollMs: 1_000,
  metricsMs: 15_000,
  backoffMs: [1_000, 2_000, 5_000, 10_000, 30_000],
};

export interface AriClientOptions {
  readonly config: Pick<BoardConfig, 'ariUrl' | 'ariUser' | 'ariPassword'>;
  readonly model: BoardModel;
  readonly log: Log;
  readonly timings?: Partial<AriTimings>;
  /** Overridable for tests. */
  readonly fetch?: typeof fetch;
}

type Reason = 'unauthorized' | 'forbidden' | 'unreachable' | 'http-error';

class AriRequestError extends Error {
  constructor(readonly reason: Reason) {
    super(`ari request failed: ${reason}`);
  }
}

/**
 * Keeps the model in step with Asterisk by reading ARI's channel, bridge and
 * endpoint lists every second, and /metrics every 15 s for what ARI does not
 * carry. It opens no events socket: that socket also takes REST requests from
 * the client, which no network policy can see into. The credential goes in an
 * Authorization header, never in a URL, and no log line carries it.
 */
export class AriClient {
  private readonly timings: AriTimings;
  private readonly authorization: string;
  private readonly fetch: typeof fetch;
  private stopped = true;
  private connected = false;
  private failures = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private metricsTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly opts: AriClientOptions) {
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    const { ariUser, ariPassword } = opts.config;
    this.authorization = `Basic ${btoa(`${ariUser}:${ariPassword}`)}`;
    this.fetch = opts.fetch ?? fetch;
  }

  start(): void {
    this.stopped = false;
    this.metricsTimer = setInterval(
      () => void this.pollMetrics(),
      this.timings.metricsMs,
    );
    void this.pollMetrics();
    void this.poll();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.metricsTimer);
  }

  private async get<T>(path: AriList): Promise<T[]> {
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
    // Cilium's proxy answers 403 for a path pbx-ari does not admit.
    if (res.status === 403) throw new AriRequestError('forbidden');
    if (!res.ok) throw new AriRequestError('http-error');
    const body: unknown = await res.json().catch(() => undefined);
    if (!Array.isArray(body)) throw new AriRequestError('http-error');
    return body as T[];
  }

  private async pollMetrics(): Promise<void> {
    try {
      // /metrics is res_prometheus's, with no auth, so it gets no credential.
      const res = await this.fetch(
        `${this.opts.config.ariUrl}${METRICS_PATH}`,
        { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!res.ok) throw new Error(String(res.status));
      this.opts.model.setMetrics(parseMetrics(await res.text()));
    } catch {
      this.opts.model.setMetrics(undefined);
    }
  }

  private async lists() {
    const [channels, bridges, endpoints] = await Promise.all([
      this.get<AriChannel>('/ari/channels'),
      this.get<AriBridge>('/ari/bridges'),
      this.get<AriEndpoint>('/ari/endpoints'),
    ]);
    return { channels, bridges, endpoints };
  }

  // One poll at a time: the next is scheduled when this one settles, so a
  // slow PBX slows the board instead of stacking requests on it.
  private async poll(): Promise<void> {
    const { model, log } = this.opts;
    let state: Awaited<ReturnType<AriClient['lists']>>;
    try {
      state = await this.lists();
    } catch (error) {
      if (this.stopped) return;
      const reason =
        error instanceof AriRequestError ? error.reason : 'unreachable';
      const steps = this.timings.backoffMs;
      const base = steps[Math.min(this.failures, steps.length - 1)] ?? 30_000;
      this.failures++;
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      this.connected = false;
      model.setLink('disconnected', reason);
      log.warn('ari unreachable', { reason, retryInMs: delay });
      this.schedule(delay);
      return;
    }
    if (this.stopped) return;
    model.load(state);
    model.setLink('connected');
    this.failures = 0;
    if (!this.connected) {
      this.connected = true;
      log.info('ari connected', { calls: model.snapshot().calls.length });
    }
    this.schedule(this.timings.pollMs);
  }

  private schedule(delay: number): void {
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }
}
