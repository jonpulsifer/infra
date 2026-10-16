/**
 * mate's voice, from ElevenLabs text-to-speech over one multi-context
 * WebSocket per call. Each utterance is a context: mate's text deltas go up
 * as they arrive, the audio comes back as 24 kHz mono and plays through the
 * call's player as one stream per utterance. A barge-in closes the context
 * that is speaking and drops the audio still on the way, so the next
 * utterance starts clean. The socket opens on the first word and is kept
 * alive between turns; a socket that drops is reopened on the next word.
 * Logs carry counts, never words.
 */
import { upsampleToStereo48k } from './audio.ts';
import type { EngineSocket } from './engine.ts';
import type { Log } from './log.ts';
import type { Playback, PlaybackStream } from './playback.ts';

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
  /** Text held back until a clause ends. */
  held: string;
  final: boolean;
}

const OPEN = 1;
const CONNECTING = 0;

/** Held text past this length goes up at its last space, clause or not. */
export const CLAUSE_MAX_CHARS = 120;
/** A comma, colon or semicolon ends a piece once this much is held. */
export const CLAUSE_MIN_CHARS = 40;
const SENTENCE_END = /[.!?…][)"']*\s/g;
const CLAUSE_END = /[,;:][)"']*\s/g;

/**
 * Where the held text can go up without cutting a thought: after the last
 * sentence end; after the last comma once enough is held; at the last space
 * once too much is held; else nowhere yet.
 */
export function clauseEnd(text: string): number {
  let last = 0;
  for (const match of text.matchAll(SENTENCE_END))
    last = match.index + match[0].length;
  if (last > 0) return last;
  if (text.length >= CLAUSE_MIN_CHARS) {
    for (const match of text.matchAll(CLAUSE_END)) {
      const end = match.index + match[0].length;
      if (end >= CLAUSE_MIN_CHARS) last = end;
    }
    if (last > 0) return last;
  }
  if (text.length >= CLAUSE_MAX_CHARS) {
    const space = text.lastIndexOf(' ');
    if (space > 0) return space + 1;
  }
  return 0;
}

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
  /** Contexts whose audio is not all in, each with its stream, queued in the order they began. */
  private readonly voicing = new Map<string, PlaybackStream>();
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
    if (final) {
      const rest = utterance.held.trim();
      utterance.held = '';
      if (rest) this.sendText(utterance, `${rest} `);
      this.finish(utterance);
      return;
    }
    // The server voices each piece as it comes, so a piece is a clause or a
    // sentence, never a word: that is where the intonation lives.
    for (
      let cut = clauseEnd(utterance.held);
      cut > 0;
      cut = clauseEnd(utterance.held)
    ) {
      const chunk = utterance.held.slice(0, cut).trim();
      utterance.held = utterance.held.slice(cut);
      if (chunk) this.sendText(utterance, `${chunk} `);
    }
  }

  /** A whole line of mate's, outside a reply. */
  announce(text: string): Promise<void> {
    return this.say(text, true);
  }

  /** The owner spoke over mate: stop the utterance and drop its audio. */
  hush(): void {
    const utterance = this.current;
    this.current = null;
    this.options.playback.stop();
    if (utterance) this.closeContext(utterance.id);
    if (this.voicing.size === 0) return;
    this.counts.hushes += 1;
    for (const id of this.voicing.keys()) this.hushed.add(id);
    this.voicing.clear();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearKeepalive();
    const socket = this.socket;
    this.socket = null;
    this.current = null;
    for (const stream of this.voicing.values()) stream.abort();
    this.voicing.clear();
    if (socket && socket.readyState === OPEN) {
      socket.send(JSON.stringify({ close_socket: true }));
      socket.close(1000, 'stopped');
    }
    this.options.log.info('tts: stopped', this.logCounts());
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
    this.voicing.set(utterance.id, this.options.playback.openStream());
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
    // A superseded socket's close is ignored below, so its utterances end here.
    if (this.current) this.counts.failures += 1;
    this.current = null;
    for (const stream of this.voicing.values()) stream.end();
    this.voicing.clear();
    this.hushed.clear();
    this.socket = socket;
    this.contexts = new Set();
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
        for (const stream of this.voicing.values()) stream.end();
        this.voicing.clear();
        this.hushed.clear();
        log.info('tts: socket closed', {
          code: event.code,
          reason: event.reason.slice(0, 120) || null,
          ...this.logCounts(),
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
      // The schema allows a frame without a context id; it belongs to the utterance under way.
      const id = message.contextId ?? this.current?.id ?? '';
      if (this.hushed.has(id) || !this.voicing.has(id)) {
        this.counts.droppedChunks += 1;
        return;
      }
      this.counts.audioChunks += 1;
      let stream = this.voicing.get(id);
      if (!stream?.open) {
        stream = this.options.playback.openStream();
        this.voicing.set(id, stream);
      }
      stream.write(
        upsampleToStereo48k(
          Buffer.from(message.audio, 'base64'),
          TTS_OUTPUT_RATE,
        ),
      );
      return;
    }
    if (message.isFinal && message.contextId) {
      this.hushed.delete(message.contextId);
      this.voicing.get(message.contextId)?.end();
      this.voicing.delete(message.contextId);
      return;
    }
    if (message.error || message.message) {
      this.counts.failures += 1;
      this.options.log.warn('tts: error', {
        error: (message.error ?? message.message ?? '').slice(0, 120),
      });
    }
  }

  private logCounts(): Record<string, number> {
    return { ...this.counts, underruns: this.options.playback.underruns };
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
