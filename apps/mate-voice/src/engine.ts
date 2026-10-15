/**
 * The conversation with ElevenLabs Speech Engine: the bridge streams the
 * owner's decoded voice up, and plays the engine's voice back. ElevenLabs
 * hears, decides when a turn ends, dials mate's brain for the words, and
 * speaks them. Logs carry counts, never audio or words.
 */
import { downmixToMono, pcmRate, upsampleToStereo48k } from './audio.ts';
import type { Log } from './log.ts';
import type { Playback } from './playback.ts';

/** Discord frames per `user_audio_chunk`: five 20 ms frames, 100 ms. */
export const FRAMES_PER_CHUNK = 5;

export interface Decoder {
  /** One Opus packet to s16le 48 kHz stereo. */
  decode(opus: Buffer): Buffer;
  delete(): void;
}

/** What the bridge needs of a WebSocket, so a test can hand it a fake. */
export type EngineSocket = Pick<
  WebSocket,
  | 'readyState'
  | 'send'
  | 'close'
  | 'onopen'
  | 'onmessage'
  | 'onclose'
  | 'onerror'
>;

export interface EngineOptions {
  /** `GET /v1/convai/conversation/get-signed-url` with the key; bounded. */
  signedUrl(signal: AbortSignal): Promise<string>;
  connect(url: string): EngineSocket;
  decoder(): Decoder;
  playback: Playback;
  log: Log;
  connectTimeoutMs: number;
  /** Called once when the conversation ends for any reason. */
  onEnd(reason: string): void;
}

export interface EngineCounts {
  heardFrames: number;
  sentChunks: number;
  audioEvents: number;
  interruptions: number;
  userTurns: number;
  agentTurns: number;
}

const OPEN = 1;

export class EngineConversation {
  private socket: EngineSocket | null = null;
  private decoder: Decoder | null = null;
  private pending: Buffer[] = [];
  private outputRate = 24_000;
  private ended = false;
  readonly counts: EngineCounts = {
    heardFrames: 0,
    sentChunks: 0,
    audioEvents: 0,
    interruptions: 0,
    userTurns: 0,
    agentTurns: 0,
  };

  constructor(private readonly options: EngineOptions) {}

  get open(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /** Fetches the signed URL and dials; a failure ends the conversation. */
  async start(): Promise<void> {
    const { log, connectTimeoutMs } = this.options;
    let url: string;
    try {
      url = await this.options.signedUrl(AbortSignal.timeout(connectTimeoutMs));
    } catch (error) {
      log.warn('speech engine: no signed url', {
        error: (error as Error).message,
      });
      this.end('no_signed_url');
      return;
    }
    if (this.ended) return;
    let socket: EngineSocket;
    try {
      socket = this.options.connect(url);
    } catch (error) {
      log.warn('speech engine: dial failed', {
        error: (error as Error).message,
      });
      this.end('dial_failed');
      return;
    }
    this.socket = socket;
    const timer = setTimeout(() => {
      if (socket.readyState !== OPEN) {
        log.warn('speech engine: connect timed out', { ms: connectTimeoutMs });
        socket.close(4000, 'connect timeout');
      }
    }, connectTimeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      this.decoder = this.options.decoder();
      socket.send(
        JSON.stringify({ type: 'conversation_initiation_client_data' }),
      );
      log.info('speech engine: conversation open');
    };
    socket.onmessage = (event) => {
      if (typeof event.data === 'string') this.receive(event.data);
    };
    socket.onerror = () => {
      log.warn('speech engine: socket error');
    };
    socket.onclose = (event) => {
      clearTimeout(timer);
      if (this.socket !== socket) return;
      this.socket = null;
      log.info('speech engine: conversation closed', {
        code: event.code,
        ...this.counts,
      });
      this.end(`closed_${event.code}`);
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
        type: 'user_audio_chunk',
        user_audio_chunk: chunk.toString('base64'),
      }),
    );
    this.counts.sentChunks += 1;
  }

  private receive(text: string): void {
    const { log, playback } = this.options;
    let message: {
      type?: string;
      conversation_initiation_metadata_event?: {
        agent_output_audio_format?: string;
        user_input_audio_format?: string;
      };
      audio_event?: { audio_base_64?: string };
      ping_event?: { event_id?: number };
      error_event?: { code?: unknown; error_name?: string };
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    switch (message.type) {
      case 'conversation_initiation_metadata': {
        const meta = message.conversation_initiation_metadata_event ?? {};
        const out = pcmRate(meta.agent_output_audio_format ?? '');
        if (out && Number.isInteger(48_000 / out)) this.outputRate = out;
        log.info('speech engine: formats', {
          in: meta.user_input_audio_format,
          out: meta.agent_output_audio_format,
        });
        if (meta.user_input_audio_format !== 'pcm_48000') {
          log.warn('speech engine: the engine wants another input rate', {
            in: meta.user_input_audio_format,
          });
        }
        return;
      }
      case 'audio': {
        const b64 = message.audio_event?.audio_base_64;
        if (!b64) return;
        this.counts.audioEvents += 1;
        playback.play(
          upsampleToStereo48k(Buffer.from(b64, 'base64'), this.outputRate),
        );
        return;
      }
      case 'interruption':
        this.counts.interruptions += 1;
        playback.stop();
        return;
      case 'ping':
        this.socket?.send(
          JSON.stringify({
            type: 'pong',
            event_id: message.ping_event?.event_id,
          }),
        );
        return;
      case 'user_transcript':
        this.counts.userTurns += 1;
        return;
      case 'agent_response':
        this.counts.agentTurns += 1;
        return;
      case 'client_error':
        log.warn('speech engine: client error', {
          code: message.error_event?.code,
          name: message.error_event?.error_name,
        });
        return;
      default:
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

export interface SignedUrlOptions {
  api: string;
  engineId: string;
  readKey(): Promise<string>;
}

/** The signed URL for one conversation, from the ElevenLabs API. */
export async function fetchSignedUrl(
  options: SignedUrlOptions,
  signal: AbortSignal,
): Promise<string> {
  const key = await options.readKey();
  const url = new URL('/v1/convai/conversation/get-signed-url', options.api);
  url.searchParams.set('agent_id', options.engineId);
  const response = await fetch(url, {
    headers: { 'xi-api-key': key },
    signal,
  });
  if (!response.ok) throw new Error(`signed url: HTTP ${response.status}`);
  const body = (await response.json()) as { signed_url?: unknown };
  if (typeof body.signed_url !== 'string')
    throw new Error('signed url: no url');
  return body.signed_url;
}
