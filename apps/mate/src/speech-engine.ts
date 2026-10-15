/**
 * ElevenLabs Speech Engine's side of mate's voice: ElevenLabs hears the
 * owner, decides when a turn ends, dials this endpoint over the tunnel, and
 * speaks what the voice lane streams back. The transcript it sends is the
 * whole context, so mate keeps no conversation state of its own here.
 *
 * Logs carry counts, never the words.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type Log, plain } from './log.ts';

export const SPEECH_ENGINE_PATH = '/speech-engine';
export const AUTHORIZATION_HEADER = 'x-elevenlabs-speech-engine-authorization';
const ISSUER = 'https://api.elevenlabs.io/convai/speech-engine';
const SUBJECT = 'convai_speech_engine_upstream';
/** Clock skew ElevenLabs allows on `exp`. */
const LEEWAY_SECONDS = 60;
/** What the owner hears when the lane cannot answer. */
export const SORRY = "I can't think right now; check the thread.";

const Turn = z.object({
  role: z.enum(['user', 'agent']),
  content: z.string(),
});
export type Turn = z.infer<typeof Turn>;

const Upstream = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), conversation_id: z.string() }),
  z.object({
    type: z.literal('user_transcript'),
    user_transcript: z.array(Turn),
    event_id: z.number().int(),
  }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('error'), message: z.string().optional() }),
]);

/** Streams the spoken reply to a transcript whose last turn is the owner's. */
export interface VoiceLane {
  reply(turns: readonly Turn[], signal: AbortSignal): AsyncIterable<string>;
}

export interface EngineSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface SpeechEngineOptions {
  log: Log;
  lane?: VoiceLane | null;
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verifies the HS256 token ElevenLabs sends on each connection. The HMAC key
 * is the raw SHA-256 digest of the API key that owns the engine; mate holds
 * that digest as hex and never the key. Returns null when valid, else why.
 */
export function verifySpeechEngineToken(
  token: string,
  keySha256Hex: string,
  nowMs: number,
): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return 'malformed token';
  const [headerB64, payloadB64, signatureB64] = parts as [
    string,
    string,
    string,
  ];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    return 'undecodable token';
  }
  if ((header as { alg?: unknown })?.alg !== 'HS256') return 'not HS256';
  const key = Buffer.from(keySha256Hex, 'hex');
  const expected = createHmac('sha256', key)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = base64UrlDecode(signatureB64);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return 'bad signature';
  const claims = payload as {
    iss?: unknown;
    sub?: unknown;
    exp?: unknown;
    iat?: unknown;
  };
  if (claims.iss !== ISSUER) return 'wrong issuer';
  if (claims.sub !== SUBJECT) return 'wrong subject';
  if (typeof claims.exp !== 'number') return 'no expiry';
  if (claims.exp + LEEWAY_SECONDS < nowMs / 1000) return 'expired';
  return null;
}

/** Why an upgrade is refused, or null to let it through. */
export function refuseSpeechEngine(
  headers: Headers,
  keySha256Hex: string | null,
  nowMs: number,
): string | null {
  if (!keySha256Hex) return 'no key configured';
  const token = headers.get(AUTHORIZATION_HEADER)?.trim();
  if (!token) return 'no token';
  return verifySpeechEngineToken(token, keySha256Hex, nowMs);
}

interface Run {
  eventId: number;
  abort: AbortController;
}

interface Session {
  socket: EngineSocket;
  conversationId: string | null;
  current: Run | null;
  /** Replies finished, interrupted and failed, for the log at close. */
  replies: number;
  interrupted: number;
  failed: number;
}

export class SpeechEngine {
  private readonly sessions = new Map<EngineSocket, Session>();
  private lane: VoiceLane | null;

  constructor(private readonly options: SpeechEngineOptions) {
    this.lane = options.lane ?? null;
  }

  /** The brain's voice lane, known once mate has built its models. */
  setLane(lane: VoiceLane | null): void {
    this.lane = lane;
  }

  get connected(): number {
    return this.sessions.size;
  }

  attach(socket: EngineSocket): void {
    this.sessions.set(socket, {
      socket,
      conversationId: null,
      current: null,
      replies: 0,
      interrupted: 0,
      failed: 0,
    });
    this.options.log.info('speech engine: connected', {
      sessions: this.sessions.size,
    });
  }

  receive(socket: EngineSocket, text: string): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.options.log.warn('speech engine: not JSON');
      return;
    }
    const parsed = Upstream.safeParse(raw);
    if (!parsed.success) {
      this.options.log.warn('speech engine: unknown message', {
        type: (raw as { type?: unknown })?.type,
      });
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'init':
        session.conversationId = message.conversation_id;
        this.options.log.info('speech engine: conversation open');
        return;
      case 'ping':
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      case 'user_transcript':
        this.answer(session, message.user_transcript, message.event_id);
        return;
      case 'close':
        this.options.log.info(
          'speech engine: conversation closed by ElevenLabs',
        );
        socket.close(1000, 'closed');
        return;
      case 'error':
        this.options.log.warn('speech engine: error from ElevenLabs', {
          message: message.message,
        });
        return;
    }
  }

  detach(socket: EngineSocket): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);
    session.current?.abort.abort();
    this.options.log.info('speech engine: disconnected', {
      replies: session.replies,
      interrupted: session.interrupted,
      failed: session.failed,
      sessions: this.sessions.size,
    });
  }

  /** Aborts every reply and closes every socket, for shutdown. */
  stop(): void {
    for (const session of [...this.sessions.values()]) {
      session.current?.abort.abort();
      session.socket.close(1001, 'mate is restarting');
      this.sessions.delete(session.socket);
    }
  }

  private answer(session: Session, turns: Turn[], eventId: number): void {
    if (session.current) {
      session.current.abort.abort();
      session.interrupted += 1;
    }
    const run: Run = { eventId, abort: new AbortController() };
    session.current = run;
    void this.stream(session, run, turns);
  }

  private async stream(
    session: Session,
    run: Run,
    turns: Turn[],
  ): Promise<void> {
    const { log } = this.options;
    const live = () => session.current === run && !run.abort.signal.aborted;
    const say = (content: string, isFinal: boolean) => {
      if (!live()) return;
      session.socket.send(
        JSON.stringify({
          type: 'agent_response',
          content,
          is_final: isFinal,
          event_id: run.eventId,
        }),
      );
    };
    const lane = this.lane;
    if (!lane) {
      log.warn('speech engine: no voice lane; apologising');
      session.failed += 1;
      say(SORRY, false);
      say('', true);
      return;
    }
    let chars = 0;
    try {
      for await (const delta of lane.reply(turns, run.abort.signal)) {
        if (!live()) return;
        chars += delta.length;
        say(delta, false);
      }
      if (!live()) return;
      say('', true);
      session.replies += 1;
      log.info('speech engine: replied', { chars, turns: turns.length });
    } catch (error) {
      if (!live()) return;
      session.failed += 1;
      log.warn('speech engine: the voice lane failed', {
        error: plain(error),
        chars,
      });
      say(SORRY, false);
      say('', true);
    }
  }
}

export interface SpeechEngineSocketData {
  engine: EngineSocket | null;
}

export function speechEngineHandlers(
  engine: SpeechEngine,
): Bun.WebSocketHandler<SpeechEngineSocketData> {
  return {
    open(ws) {
      const socket: EngineSocket = {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      };
      ws.data.engine = socket;
      engine.attach(socket);
    },
    message(ws, data) {
      const socket = ws.data.engine;
      if (!socket || typeof data !== 'string') return;
      engine.receive(socket, data);
    },
    close(ws) {
      const socket = ws.data.engine;
      ws.data.engine = null;
      if (socket) engine.detach(socket);
    },
  };
}
