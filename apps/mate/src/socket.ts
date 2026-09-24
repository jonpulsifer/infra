/**
 * Slack Socket Mode on Bun's WebSocket. Everything inbound arrives here, so
 * mate needs no public HTTP endpoint and no request-signature check.
 */
import type { Clock } from './clock.ts';
import { type Log, plain } from './log.ts';

export interface SocketLike {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** The outer event_callback Slack wraps an event in. */
export interface EventPayload {
  event_id?: string;
  event_time?: number;
  team_id?: string;
  event?: Record<string, unknown>;
}

export interface SocketModeDeps {
  /** Opens a connection and hands back the `wss://` url to dial. */
  open(): Promise<string>;
  connect(url: string): SocketLike;
  clock: Clock;
  log: Log;
  /** One events_api payload, already acknowledged. */
  onEvent(payload: EventPayload): void;
  /** Epoch ms. Older events are Slack's replay buffer, and are dropped. */
  since: number;
  /** How many connections this app should have. More than one splits events. */
  expected?: number;
}

/** Event ids kept to recognise a redelivery, bounded so the set cannot grow. */
export const SEEN_LIMIT = 512;
export const RECONNECT_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

export class SocketMode {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private socket: SocketLike | null = null;
  private stopped = false;
  private backoff = RECONNECT_MS;

  constructor(private readonly deps: SocketModeDeps) {}

  /** Connects, and keeps connecting: Slack recycles a socket every few hours. */
  async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.session();
      } catch (error) {
        this.deps.log.warn('slack socket failed', { error: plain(error) });
      }
      if (this.stopped) return;
      await this.deps.clock.sleep(this.backoff).catch(() => {});
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    }
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close(1000, 'shutting down');
  }

  private async session(): Promise<void> {
    const url = await this.deps.open();
    const socket = this.deps.connect(url);
    this.socket = socket;
    const ended = Promise.withResolvers<void>();
    socket.addEventListener('message', (event) => {
      this.frame(String((event as { data?: unknown }).data));
    });
    socket.addEventListener('close', () => ended.resolve());
    socket.addEventListener('error', (event) => {
      this.deps.log.warn('slack socket error', {
        error: String((event as { message?: unknown }).message ?? 'unknown'),
      });
      ended.resolve();
    });
    await ended.promise;
    this.socket = null;
  }

  private frame(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      this.deps.log.warn('slack sent a frame that is not json');
      return;
    }
    if (frame.type === 'hello') {
      this.hello(frame);
      return;
    }
    if (frame.type === 'disconnect') {
      this.deps.log.info('slack asked for a reconnect', {
        reason: frame.reason,
      });
      this.socket?.close(1000, 'reconnecting');
      return;
    }
    // First: Slack redelivers any envelope not acked within three seconds,
    // including ones mate ignores.
    if (typeof frame.envelope_id === 'string') this.ack(frame.envelope_id);
    if (frame.type === 'events_api') this.event(frame.payload as EventPayload);
  }

  private hello(frame: Record<string, unknown>): void {
    this.backoff = RECONNECT_MS;
    const connections = Number(frame.num_connections ?? 0);
    const info = frame.connection_info as { app_id?: string } | undefined;
    this.deps.log.info('slack socket ready', {
      connections,
      appId: info?.app_id ?? null,
    });
    // Slack splits payloads across an app's connections, so each mate sharing
    // the token sees only some of them.
    const expected = this.deps.expected ?? 1;
    if (connections !== expected) {
      this.deps.log.warn('slack is splitting events across connections', {
        connections,
        expected,
      });
    }
  }

  private event(payload: EventPayload | undefined): void {
    const id = payload?.event_id;
    if (!payload || !id || this.remember(id)) return;
    if ((payload.event_time ?? 0) * 1000 < this.deps.since) {
      this.deps.log.info('slack replayed an event from before this process', {
        eventId: id,
      });
      return;
    }
    this.deps.onEvent(payload);
  }

  /** True when this event has already been handled. */
  private remember(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > SEEN_LIMIT) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
    return false;
  }

  private ack(envelopeId: string): void {
    try {
      this.socket?.send(JSON.stringify({ envelope_id: envelopeId }));
    } catch (error) {
      this.deps.log.warn('slack ack failed', { error: plain(error) });
    }
  }
}
