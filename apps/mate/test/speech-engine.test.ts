import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  AUTHORIZATION_HEADER,
  refuseSpeechEngine,
  SORRY,
  SpeechEngine,
  type Turn,
  type VoiceLane,
  verifySpeechEngineToken,
} from '../src/speech-engine.ts';
import { RecordingLog } from './support.ts';

const API_KEY = 'sk_test_0123456789abcdef';
const KEY_HEX = createHash('sha256').update(API_KEY, 'utf8').digest('hex');
const NOW = 1_800_000_000_000;

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64url');

function token(
  claims: Record<string, unknown>,
  apiKey = API_KEY,
  alg = 'HS256',
): string {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const key = createHash('sha256').update(apiKey, 'utf8').digest();
  const signature = createHmac('sha256', key)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const CLAIMS = {
  iss: 'https://api.elevenlabs.io/convai/speech-engine',
  sub: 'convai_speech_engine_upstream',
  iat: NOW / 1000 - 10,
  exp: NOW / 1000 + 50,
};

describe('the Speech Engine token', () => {
  test('passes when signed with the SHA-256 of the API key and the claims hold', () => {
    expect(verifySpeechEngineToken(token(CLAIMS), KEY_HEX, NOW)).toBeNull();
  });

  test('names what is wrong: signature, issuer, subject, expiry, shape', () => {
    expect(verifySpeechEngineToken(token(CLAIMS, 'other'), KEY_HEX, NOW)).toBe(
      'bad signature',
    );
    expect(
      verifySpeechEngineToken(token({ ...CLAIMS, iss: 'x' }), KEY_HEX, NOW),
    ).toBe('wrong issuer');
    expect(
      verifySpeechEngineToken(token({ ...CLAIMS, sub: 'x' }), KEY_HEX, NOW),
    ).toBe('wrong subject');
    expect(
      verifySpeechEngineToken(
        token({ ...CLAIMS, exp: NOW / 1000 - 61 }),
        KEY_HEX,
        NOW,
      ),
    ).toBe('expired');
    expect(
      verifySpeechEngineToken(
        token({ ...CLAIMS, exp: NOW / 1000 - 30 }),
        KEY_HEX,
        NOW,
      ),
    ).toBeNull();
    expect(verifySpeechEngineToken('a.b', KEY_HEX, NOW)).toBe(
      'malformed token',
    );
    expect(
      verifySpeechEngineToken(token(CLAIMS, API_KEY, 'none'), KEY_HEX, NOW),
    ).toBe('not HS256');
  });

  test('an upgrade is refused without a configured key, or a header', () => {
    const headers = new Headers({ [AUTHORIZATION_HEADER]: token(CLAIMS) });
    expect(refuseSpeechEngine(headers, null, NOW)).toBe('no key configured');
    expect(refuseSpeechEngine(new Headers(), KEY_HEX, NOW)).toBe('no token');
    expect(refuseSpeechEngine(headers, KEY_HEX, NOW)).toBeNull();
  });

  test('the Bearer prefix ElevenLabs sends is stripped', () => {
    const headers = new Headers({
      [AUTHORIZATION_HEADER]: `Bearer ${token(CLAIMS)}`,
    });
    expect(refuseSpeechEngine(headers, KEY_HEX, NOW)).toBeNull();
    expect(
      verifySpeechEngineToken(`bearer ${token(CLAIMS, 'other')}`, KEY_HEX, NOW),
    ).toBe('bad signature');
  });
});

class FakeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | null = null;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  responses() {
    return this.sent.filter((m) => m.type === 'agent_response');
  }
}

/** A lane that speaks its script one word at a time, waiting on a gate between words. */
function scriptedLane(words: string[], gate?: () => Promise<void>) {
  const heard: Turn[][] = [];
  const conversations: string[] = [];
  const lane: VoiceLane = {
    async *reply(turns, signal, conversationId) {
      heard.push([...turns]);
      conversations.push(conversationId);
      for (const word of words) {
        if (gate) await gate();
        if (signal.aborted) return;
        yield word;
      }
    },
  };
  return { lane, heard, conversations };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const transcript = (eventId: number, ...lines: string[]) =>
  JSON.stringify({
    type: 'user_transcript',
    user_transcript: lines.map((content, i) => ({
      role: i % 2 === 0 ? 'user' : 'agent',
      content,
    })),
    event_id: eventId,
  });

describe('the Speech Engine link', () => {
  test('answers a ping, and streams a reply with the turn id then an empty final', async () => {
    const log = new RecordingLog();
    const { lane, heard, conversations } = scriptedLane(['hi ', 'there']);
    const engine = new SpeechEngine({ log, lane });
    const socket = new FakeSocket();
    engine.attach(socket);
    engine.receive(
      socket,
      JSON.stringify({ type: 'init', conversation_id: 'c' }),
    );
    engine.receive(socket, JSON.stringify({ type: 'ping' }));
    expect(socket.sent).toEqual([{ type: 'pong' }]);
    engine.receive(socket, transcript(1, 'hello', 'yo', 'how are you'));
    await settle();
    expect(socket.responses()).toEqual([
      { type: 'agent_response', content: 'hi ', is_final: false, event_id: 1 },
      {
        type: 'agent_response',
        content: 'there',
        is_final: false,
        event_id: 1,
      },
      { type: 'agent_response', content: '', is_final: true, event_id: 1 },
    ]);
    expect(heard[0]?.map((t) => t.role)).toEqual(['user', 'agent', 'user']);
    expect(conversations).toEqual(['c']);
    expect(log.of('speech engine: replied')[0]?.fields).toMatchObject({
      chars: 8,
      turns: 3,
    });
    engine.detach(socket, 1002, 'speech_engine_error: x');
    expect(log.of('speech engine: disconnected')[0]?.fields).toMatchObject({
      code: 1002,
      reason: 'speech_engine_error: x',
      replies: 1,
      interrupted: 0,
      failed: 0,
    });
  });

  test('a newer transcript interrupts the reply under way; the old one sends nothing more', async () => {
    let release = () => {};
    const gate = () => new Promise<void>((resolve) => (release = resolve));
    const { lane } = scriptedLane(['one ', 'two ', 'three'], gate);
    const engine = new SpeechEngine({ log: new RecordingLog(), lane });
    const socket = new FakeSocket();
    engine.attach(socket);
    engine.receive(socket, transcript(1, 'first'));
    await settle();
    release();
    await settle();
    expect(socket.responses()).toHaveLength(1);
    engine.receive(socket, transcript(2, 'first', 'one ', 'second'));
    await settle();
    release();
    await settle();
    release();
    await settle();
    release();
    await settle();
    release();
    await settle();
    const ids = socket.responses().map((r) => r.event_id);
    expect(ids.filter((id) => id === 1)).toHaveLength(1);
    expect(socket.responses().at(-1)).toEqual({
      type: 'agent_response',
      content: '',
      is_final: true,
      event_id: 2,
    });
  });

  test('apologises when the lane fails, or when there is no lane yet', async () => {
    const log = new RecordingLog();
    const failing: VoiceLane = {
      // biome-ignore lint/correctness/useYield: it throws before any word
      async *reply() {
        throw new Error('model down');
      },
    };
    const engine = new SpeechEngine({ log });
    const socket = new FakeSocket();
    engine.attach(socket);
    engine.receive(socket, transcript(1, 'hello'));
    await settle();
    expect(socket.responses().map((r) => r.content)).toEqual([SORRY, '']);
    engine.setLane(failing);
    engine.receive(socket, transcript(2, 'hello'));
    await settle();
    expect(
      socket
        .responses()
        .slice(2)
        .map((r) => r.content),
    ).toEqual([SORRY, '']);
    expect(log.of('speech engine: the voice lane failed')).toHaveLength(1);
    const failed = log.of('speech engine: the voice lane failed')[0]?.fields;
    expect(JSON.stringify(failed)).not.toContain('hello');
  });

  test('close from ElevenLabs closes the socket; stop closes every session', () => {
    const engine = new SpeechEngine({ log: new RecordingLog() });
    const a = new FakeSocket();
    const b = new FakeSocket();
    engine.attach(a);
    engine.attach(b);
    engine.receive(a, JSON.stringify({ type: 'close' }));
    expect(a.closed?.code).toBe(1000);
    engine.stop();
    expect(b.closed?.code).toBe(1001);
    expect(engine.connected).toBe(0);
  });
});
