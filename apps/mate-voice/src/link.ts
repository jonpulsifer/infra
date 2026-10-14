/**
 * The bridge's side of the channel to mate: it dials mate's WebSocket, keeps
 * dialling with backoff, and treats a quiet link as a lost one. Bun's
 * WebSocket has no connect timeout, so every dial is bounded by a timer.
 */
import type { Log } from './log.ts';
import {
  decodeFromMate,
  encode,
  type FromBridge,
  type FromMate,
} from './protocol.ts';

export interface LinkOptions {
  url: string;
  log: Log;
  heartbeatMs: number;
  connectTimeoutMs: number;
  onOpen(): void;
  onMessage(message: FromMate): void;
  onClose(): void;
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Heartbeats missed in a row before the link is declared lost. */
const QUIET_BEATS = 3;

export class MateLink {
  private socket: WebSocket | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_MIN_MS;
  private redial: ReturnType<typeof setTimeout> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private lastHeard = 0;
  dropped = 0;

  constructor(private readonly options: LinkOptions) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.dial();
  }

  stop(): void {
    this.stopped = true;
    if (this.redial) clearTimeout(this.redial);
    this.redial = null;
    this.stopBeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'bridge stopping');
  }

  send(message: FromBridge): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.dropped++;
      return false;
    }
    socket.send(encode(message));
    return true;
  }

  private dial(): void {
    if (this.stopped) return;
    const { url, log, connectTimeoutMs } = this.options;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      log.warn('mate link dial failed', { error: (error as Error).message });
      this.scheduleRedial();
      return;
    }
    this.socket = socket;
    const connectTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        log.warn('mate link connect timed out', { ms: connectTimeoutMs });
        socket.close();
      }
    }, connectTimeoutMs);
    socket.onopen = () => {
      clearTimeout(connectTimer);
      this.backoffMs = BACKOFF_MIN_MS;
      this.lastHeard = Date.now();
      this.startBeat();
      log.info('mate link open');
      this.options.onOpen();
    };
    socket.onmessage = (event) => {
      this.lastHeard = Date.now();
      if (typeof event.data !== 'string') return;
      const message = decodeFromMate(event.data);
      if (!message) {
        log.warn('mate sent an unknown message');
        return;
      }
      if (message.type === 'heartbeat') return;
      this.options.onMessage(message);
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      clearTimeout(connectTimer);
      const wasOpen = this.socket === socket;
      if (wasOpen) this.socket = null;
      this.stopBeat();
      if (this.stopped) return;
      log.warn('mate link closed', { code: event.code });
      if (wasOpen) this.options.onClose();
      this.scheduleRedial();
    };
  }

  private scheduleRedial(): void {
    if (this.stopped || this.redial) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.redial = setTimeout(() => {
      this.redial = null;
      this.dial();
    }, delay);
  }

  private startBeat(): void {
    this.stopBeat();
    const { heartbeatMs, log } = this.options;
    this.beat = setInterval(() => {
      if (Date.now() - this.lastHeard > heartbeatMs * QUIET_BEATS) {
        log.warn('mate link quiet; closing', {
          quietMs: heartbeatMs * QUIET_BEATS,
        });
        this.socket?.close(4000, 'quiet');
        return;
      }
      this.send({ type: 'heartbeat' });
    }, heartbeatMs);
  }

  private stopBeat(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
  }
}
