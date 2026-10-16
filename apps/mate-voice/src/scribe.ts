/**
 * The owner's words, from ElevenLabs Scribe over one realtime WebSocket per
 * call: the bridge streams the owner's decoded voice up as 48 kHz mono and
 * gets partial and committed transcripts back. Scribe's own VAD decides when
 * an utterance ends. A session that drops is redialled a bounded number of
 * times; past the cap the ears end and the call goes deaf. Logs carry
 * counts, never audio or words.
 */
import { downmixToMono } from './audio.ts';
import type { Decoder, EngineSocket } from './engine.ts';
import type { Log } from './log.ts';

export const SCRIBE_PATH = '/v1/speech-to-text/realtime';
export const SCRIBE_MODEL = 'scribe_v2_realtime';
export const SCRIBE_SAMPLE_RATE = 48_000;
/** Discord frames per chunk: five 20 ms frames, 100 ms. */
export const FRAMES_PER_CHUNK = 5;

export interface ScribeOptions {
  /** `https://api.elevenlabs.io`; the socket URL is derived. */
  api: string;
  readKey(): Promise<string>;
  connect(url: string, headers: Record<string, string>): EngineSocket;
  decoder(): Decoder;
  log: Log;
  connectTimeoutMs: number;
  /** Redials in one call before the ears give up. */
  redialCap: number;
  /** An interim transcript of the utterance in progress; it may change. */
  onPartial(text: string): void;
  /** The utterance Scribe's VAD closed. */
  onCommitted(text: string): void;
  /** Called once, when the ears end for any reason. */
  onEnd(reason: string): void;
}

export interface ScribeCounts {
  heardFrames: number;
  sentChunks: number;
  partials: number;
  commits: number;
  redials: number;
}

const OPEN = 1;

/** The socket URL for one session. */
export function scribeUrl(api: string): string {
  const url = new URL(SCRIBE_PATH, api);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.searchParams.set('model_id', SCRIBE_MODEL);
  url.searchParams.set('audio_format', `pcm_${SCRIBE_SAMPLE_RATE}`);
  url.searchParams.set('commit_strategy', 'vad');
  url.searchParams.set('language_code', 'en');
  return url.toString();
}

export class ScribeEars {
  private socket: EngineSocket | null = null;
  private decoder: Decoder | null = null;
  private pending: Buffer[] = [];
  private ended = false;
  private stopping = false;
  readonly counts: ScribeCounts = {
    heardFrames: 0,
    sentChunks: 0,
    partials: 0,
    commits: 0,
    redials: 0,
  };

  constructor(private readonly options: ScribeOptions) {}

  get open(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Dials Scribe; a failure to read the key ends the ears. */
  async start(): Promise<void> {
    if (this.ended) return;
    const { log } = this.options;
    let key: string;
    try {
      key = await this.options.readKey();
    } catch (error) {
      log.warn('scribe: no key', { error: (error as Error).message });
      this.end('no_key');
      return;
    }
    if (this.ended) return;
    let socket: EngineSocket;
    try {
      socket = this.options.connect(scribeUrl(this.options.api), {
        'xi-api-key': key,
      });
    } catch (error) {
      log.warn('scribe: dial failed', { error: (error as Error).message });
      this.end('dial_failed');
      return;
    }
    this.socket = socket;
    const timer = setTimeout(() => {
      if (socket.readyState !== OPEN) {
        log.warn('scribe: connect timed out', {
          ms: this.options.connectTimeoutMs,
        });
        socket.close(4000, 'connect timeout');
      }
    }, this.options.connectTimeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      this.decoder ??= this.options.decoder();
      log.info('scribe: session open', { redials: this.counts.redials });
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.receive(event.data);
    };
    socket.onerror = () => {
      log.warn('scribe: socket error');
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      if (this.socket !== socket) return;
      this.socket = null;
      this.pending = [];
      log.info('scribe: session closed', {
        code: event.code,
        reason: event.reason.slice(0, 120) || null,
        ...this.counts,
      });
      if (this.stopping || this.ended) return;
      if (this.counts.redials >= this.options.redialCap) {
        this.end('redial_cap');
        return;
      }
      this.counts.redials += 1;
      void this.start();
    };
  }

  /** One of the owner's Opus frames, straight from Discord. */
  hear(opus: Buffer): void {
    this.counts.heardFrames += 1;
    if (!this.open || !this.decoder) return;
    let pcm: Buffer;
    try {
      pcm = this.decoder.decode(opus);
    } catch {
      return;
    }
    this.pending.push(downmixToMono(pcm));
    if (this.pending.length >= FRAMES_PER_CHUNK) this.flush();
  }

  stop(): void {
    this.stopping = true;
    this.end('stopped');
  }

  private flush(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN || this.pending.length === 0)
      return;
    const chunk = Buffer.concat(this.pending);
    this.pending = [];
    socket.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: chunk.toString('base64'),
        commit: false,
        sample_rate: SCRIBE_SAMPLE_RATE,
      }),
    );
    this.counts.sentChunks += 1;
  }

  private receive(text: string): void {
    const { log } = this.options;
    let message: {
      message_type?: string;
      text?: string;
      error?: string;
      warning?: string;
      config?: { commit_strategy?: string; sample_rate?: number };
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message.message_type) {
      case 'session_started':
        log.info('scribe: session started', {
          commitStrategy: message.config?.commit_strategy ?? null,
          sampleRate: message.config?.sample_rate ?? null,
        });
        return;
      case 'partial_transcript': {
        const words = (message.text ?? '').trim();
        if (!words) return;
        this.counts.partials += 1;
        this.options.onPartial(words);
        return;
      }
      case 'committed_transcript': {
        const words = (message.text ?? '').trim();
        if (!words) return;
        this.counts.commits += 1;
        this.options.onCommitted(words);
        return;
      }
      case 'committed_transcript_with_timestamps':
      case 'committed_transcript_entities':
      case 'edited_transcript':
        return;
      case 'warning':
        log.warn('scribe: warning', {
          warning: (message.warning ?? '').slice(0, 120),
        });
        return;
      default:
        // Every other message type is an error; Scribe closes after most.
        if (message.message_type) {
          log.warn('scribe: error', {
            type: message.message_type,
            error: (message.error ?? '').slice(0, 120),
          });
        }
        return;
    }
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === OPEN) socket.close(1000, reason);
    this.decoder?.delete();
    this.decoder = null;
    this.pending = [];
    this.options.onEnd(reason);
  }
}
