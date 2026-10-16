/**
 * mate's voice, from ElevenLabs text-to-speech over one multi-context
 * WebSocket per call. Each utterance is a context: mate's text deltas go up
 * as they arrive, the audio comes back as 24 kHz mono and plays through the
 * call's player. A barge-in closes the context that is speaking and drops
 * the audio still on the way, so the next utterance starts clean. The socket
 * opens on the first word and is kept alive between turns; a socket that
 * drops is reopened on the next word. Logs carry counts, never words.
 */
import { upsampleToStereo48k } from './audio.ts';
import type { EngineSocket } from './engine.ts';
import type { Log } from './log.ts';
import type { Playback } from './playback.ts';

export const TTS_OUTPUT_RATE = 24_000;
/** The longest the server keeps an idle socket; keepalives beat it. */
export const TTS_INACTIVITY_SECS = 180;
export const KEEPALIVE_MS = 60_000;
const KEEPALIVE_CONTEXT = 'keep';

export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  speed?: number;
}

export interface MouthOptions {
  /** `https://api.elevenlabs.io`; the socket URL is derived. */
  api: string;
  voiceId: string;
  modelId: string;
  voiceSettings?: VoiceSettings;
  readKey(): Promise<string>;
  connect(url: string, headers: Record<string, string>): EngineSocket;
  playback: Playback;
  log: Log;
  connectTimeoutMs: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export interface MouthCounts {
  utterances: number;
  chars: number;
  audioChunks: number;
  droppedChunks: number;
  hushes: number;
  dials: number;
  failures: number;
}

interface Utterance {
  id: string;
  /** Characters sent to the server so far. */
  sent: number;
  /** Text held back until a word boundary. */
  held: string;
  final: boolean;
}

const OPEN = 1;
const CONNECTING = 0;

/** The socket URL for one call. */
export function ttsUrl(api: string, voiceId: string, modelId: string): string {
  const url = new URL(
    `/v1/text-to-speech/${encodeURIComponent(voiceId)}/multi-stream-input`,
    api,
  );
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('model_id', modelId);
  url.searchParams.set('output_format', `pcm_${TTS_OUTPUT_RATE}`);
  url.searchParams.set('auto_mode', 'true');
  url.searchParams.set('inactivity_timeout', String(TTS_INACTIVITY_SECS));
  return url.toString();
}

export class Mouth {
  private socket: EngineSocket | null = null;
  private opening: Promise<boolean> | null = null;
  /** The contexts the server knows about, the first one included. */
  private contexts = new Set<string>();
  private current: Utterance | null = null;
  /** Contexts closed early whose audio is still arriving. */
  private readonly hushed = new Set<string>();
  private sequence = 0;
  private keepalive: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  readonly counts: MouthCounts = {
    utterances: 0,
    chars: 0,
    audioChunks: 0,
    droppedChunks: 0,
    hushes: 0,
    dials: 0,
    failures: 0,
  };

  constructor(private readonly options: MouthOptions) {}

  get open(): boolean {
    return this.socket?.readyState === OPEN;
  }

  get speaking(): boolean {
    return this.current !== null || !this.options.playback.idle;
  }

  /** Characters of the utterance in progress that have been voiced so far: what the owner may have heard. */
  get heardChars(): number {
    return this.current?.sent ?? 0;
  }

  /**
   * Part of mate's reply. Text is sent at word boundaries; `final` sends the
   * rest and closes the utterance. A new utterance after a final one gets a
   * fresh context.
   */
  async say(text: string, final: boolean): Promise<void> {
    if (this.stopped) return;
    if (!text && !this.current) return;
    if (!(await this.ensureOpen())) {
      this.counts.failures += 1;
      return;
    }
    const utterance = this.current ?? this.begin();
    utterance.held += text;
    const boundary = final
      ? utterance.held.length
      : utterance.held.lastIndexOf(' ') + 1;
    if (boundary > 0) {
      const chunk = utterance.held.slice(0, boundary);
      utterance.held = utterance.held.slice(boundary);
      this.sendText(utterance, final ? `${chunk} ` : chunk);
    }
    if (final) this.finish(utterance);
  }

  /** A whole line of mate's, outside a reply. */
  announce(text: string): Promise<void> {
    return this.say(text, true);
  }

  /** The owner spoke over mate: stop the utterance and drop its audio. */
  hush(): void {
    const utterance = this.current;
    this.options.playback.stop();
    if (!utterance) return;
    this.counts.hushes += 1;
    this.current = null;
    this.hushed.add(utterance.id);
    this.closeContext(utterance.id);
  }

  stop(): void {
    this.stopped = true;
    this.clearKeepalive();
    const socket = this.socket;
    this.socket = null;
    this.current = null;
    if (socket && socket.readyState === OPEN) {
      socket.send(JSON.stringify({ close_socket: true }));
      socket.close(1000, 'stopped');
    }
  }

  private begin(): Utterance {
    this.sequence += 1;
    const utterance: Utterance = {
      id: `u${this.sequence}`,
      sent: 0,
      held: '',
      final: false,
    };
    this.current = utterance;
    this.counts.utterances += 1;
    this.initContext(utterance.id);
    return utterance;
  }

  private finish(utterance: Utterance): void {
    utterance.final = true;
    const socket = this.socket;
    if (socket?.readyState === OPEN) {
      socket.send(
        JSON.stringify({ context_id: utterance.id, text: '', flush: true }),
      );
      socket.send(
        JSON.stringify({ context_id: utterance.id, close_context: true }),
      );
    }
    this.contexts.delete(utterance.id);
    if (this.current === utterance) this.current = null;
  }

  private sendText(utterance: Utterance, text: string): void {
    const socket = this.socket;
    if (!text || socket?.readyState !== OPEN) return;
    socket.send(JSON.stringify({ context_id: utterance.id, text }));
    utterance.sent += text.length;
    this.counts.chars += text.length;
  }

  private initContext(id: string): void {
    const socket = this.socket;
    if (socket?.readyState !== OPEN) return;
    socket.send(
      JSON.stringify({
        context_id: id,
        text: ' ',
        voice_settings: this.options.voiceSettings,
      }),
    );
    this.contexts.add(id);
  }

  private closeContext(id: string): void {
    const socket = this.socket;
    this.contexts.delete(id);
    if (socket?.readyState !== OPEN) return;
    socket.send(JSON.stringify({ context_id: id, close_context: true }));
  }

  private ensureOpen(): Promise<boolean> {
    if (this.open) return Promise.resolve(true);
    if (this.opening) return this.opening;
    this.opening = this.dial().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async dial(): Promise<boolean> {
    const { log, connectTimeoutMs } = this.options;
    let key: string;
    try {
      key = await this.options.readKey();
    } catch (error) {
      log.warn('tts: no key', { error: (error as Error).message });
      return false;
    }
    if (this.stopped) return false;
    let socket: EngineSocket;
    try {
      socket = this.options.connect(
        ttsUrl(this.options.api, this.options.voiceId, this.options.modelId),
        { 'xi-api-key': key },
      );
    } catch (error) {
      log.warn('tts: dial failed', { error: (error as Error).message });
      return false;
    }
    this.counts.dials += 1;
    this.socket = socket;
    this.contexts = new Set();
    this.current = null;
    return new Promise<boolean>((resolve) => {
      const setTimer = this.options.setTimer ?? setTimeout;
      const timer = setTimer(() => {
        if (socket.readyState === CONNECTING) {
          log.warn('tts: connect timed out', { ms: connectTimeoutMs });
          socket.close(4000, 'connect timeout');
          resolve(false);
        }
      }, connectTimeoutMs);
      socket.onopen = () => {
        (this.options.clearTimer ?? clearTimeout)(timer);
        // The first message on a socket makes its first context.
        socket.send(
          JSON.stringify({
            context_id: KEEPALIVE_CONTEXT,
            text: ' ',
            voice_settings: this.options.voiceSettings,
          }),
        );
        this.contexts.add(KEEPALIVE_CONTEXT);
        this.startKeepalive();
        log.info('tts: socket open', { dials: this.counts.dials });
        resolve(true);
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') this.receive(event.data);
      };
      socket.onerror = () => {
        log.warn('tts: socket error');
      };
      socket.onclose = (event) => {
        (this.options.clearTimer ?? clearTimeout)(timer);
        if (this.socket !== socket) return;
        this.socket = null;
        this.clearKeepalive();
        if (this.current) {
          this.counts.failures += 1;
          this.current = null;
        }
        log.info('tts: socket closed', {
          code: event.code,
          reason: event.reason.slice(0, 120) || null,
          ...this.counts,
        });
        resolve(false);
      };
    });
  }

  private receive(text: string): void {
    let message: {
      audio?: string;
      isFinal?: boolean;
      contextId?: string;
      error?: string;
      message?: string;
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.audio) {
      if (message.contextId && this.hushed.has(message.contextId)) {
        this.counts.droppedChunks += 1;
        return;
      }
      this.counts.audioChunks += 1;
      this.options.playback.play(
        upsampleToStereo48k(
          Buffer.from(message.audio, 'base64'),
          TTS_OUTPUT_RATE,
        ),
      );
      return;
    }
    if (message.isFinal && message.contextId) {
      this.hushed.delete(message.contextId);
      return;
    }
    if (message.error || message.message) {
      this.counts.failures += 1;
      this.options.log.warn('tts: error', {
        error: (message.error ?? message.message ?? '').slice(0, 120),
      });
    }
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    const setTimer = this.options.setTimer ?? setTimeout;
    const tick = () => {
      const socket = this.socket;
      if (socket?.readyState !== OPEN) return;
      socket.send(JSON.stringify({ context_id: KEEPALIVE_CONTEXT, text: '' }));
      this.keepalive = setTimer(tick, KEEPALIVE_MS);
    };
    this.keepalive = setTimer(tick, KEEPALIVE_MS);
  }

  private clearKeepalive(): void {
    if (this.keepalive)
      (this.options.clearTimer ?? clearTimeout)(this.keepalive);
    this.keepalive = null;
  }
}
