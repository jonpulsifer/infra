import { describe, expect, test } from 'bun:test';
import type { AudioPlayer } from '@discordjs/voice';
import {
  type Decoder,
  EngineConversation,
  type EngineSocket,
  FRAMES_PER_CHUNK,
  fetchSignedUrl,
} from '../src/engine.ts';
import { Playback } from '../src/playback.ts';
import { capturingLog, FakePlayer } from './fakes.ts';

class FakeWebSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' } as CloseEvent);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

/** Decodes any packet to one 20 ms stereo frame of its first byte's value. */
const decoder = (): Decoder & { deleted: boolean } => ({
  deleted: false,
  decode(opus: Buffer) {
    const pcm = Buffer.alloc(960 * 4);
    for (let i = 0; i < 960; i++) {
      pcm.writeInt16LE(opus[0] ?? 0, i * 4);
      pcm.writeInt16LE(opus[0] ?? 0, i * 4 + 2);
    }
    return pcm;
  },
  delete() {
    this.deleted = true;
  },
});

function harness(signedUrl = async () => 'wss://engine.test/conv') {
  const sockets: FakeWebSocket[] = [];
  const player = new FakePlayer();
  const playback = new Playback(player as unknown as AudioPlayer);
  const log = capturingLog();
  const ends: string[] = [];
  const dec = decoder();
  const engine = new EngineConversation({
    signedUrl,
    connect: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as EngineSocket;
    },
    decoder: () => dec,
    playback,
    log,
    connectTimeoutMs: 50,
    onEnd: (reason) => ends.push(reason),
  });
  return { engine, sockets, player, playback, log, ends, dec };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('the ElevenLabs conversation', () => {
  test('dials the signed url, opens with the initiation message, and answers pings', async () => {
    const h = harness();
    await h.engine.start();
    const socket = h.sockets[0];
    expect(socket?.url).toBe('wss://engine.test/conv');
    socket?.open();
    expect(socket?.sent).toEqual([
      { type: 'conversation_initiation_client_data' },
    ]);
    socket?.receive({ type: 'ping', ping_event: { event_id: 7 } });
    expect(socket?.sent.at(-1)).toEqual({ type: 'pong', event_id: 7 });
    expect(h.engine.open).toBe(true);
  });

  test('sends the owner as mono chunks of five frames, and nothing before the socket opens', async () => {
    const h = harness();
    await h.engine.start();
    const socket = h.sockets[0];
    h.engine.hear(Buffer.from([10]));
    expect(socket?.sent).toEqual([]);
    socket?.open();
    for (let i = 0; i < FRAMES_PER_CHUNK - 1; i++)
      h.engine.hear(Buffer.from([10]));
    expect(
      socket?.sent.filter((m) => m.type === 'user_audio_chunk'),
    ).toHaveLength(0);
    h.engine.hear(Buffer.from([10]));
    const chunk = socket?.sent.find((m) => m.type === 'user_audio_chunk');
    const pcm = Buffer.from(chunk?.user_audio_chunk as string, 'base64');
    expect(pcm.length).toBe(FRAMES_PER_CHUNK * 960 * 2);
    expect(pcm.readInt16LE(0)).toBe(10);
    expect(h.engine.counts).toMatchObject({ heardFrames: 6, sentChunks: 1 });
  });

  test('plays the engine voice at 48 kHz stereo, flushes on interruption, and counts turns', async () => {
    const h = harness();
    await h.engine.start();
    const socket = h.sockets[0];
    socket?.open();
    socket?.receive({
      type: 'conversation_initiation_metadata',
      conversation_initiation_metadata_event: {
        conversation_id: 'c',
        agent_output_audio_format: 'pcm_24000',
        user_input_audio_format: 'pcm_48000',
      },
    });
    const mono = Buffer.alloc(240 * 2);
    socket?.receive({
      type: 'audio',
      audio_event: { audio_base_64: mono.toString('base64'), event_id: 1 },
    });
    expect(h.player.played).toBe(1);
    socket?.receive({
      type: 'interruption',
      interruption_event: { event_id: 1 },
    });
    expect(h.player.stops.length).toBeGreaterThan(0);
    socket?.receive({ type: 'user_transcript', user_transcription_event: {} });
    socket?.receive({ type: 'agent_response', agent_response_event: {} });
    expect(h.engine.counts).toMatchObject({
      audioEvents: 1,
      interruptions: 1,
      userTurns: 1,
      agentTurns: 1,
    });
  });

  test('ends once: on stop it closes and frees the decoder; on a close it reports the code', async () => {
    const h = harness();
    await h.engine.start();
    h.sockets[0]?.open();
    h.engine.stop();
    expect(h.sockets[0]?.closed?.code).toBe(1000);
    expect(h.dec.deleted).toBe(true);
    expect(h.ends).toEqual(['stopped']);
    const other = harness();
    await other.engine.start();
    other.sockets[0]?.open();
    other.sockets[0]?.close(4300, 'queue');
    expect(other.ends).toEqual(['closed_4300']);
  });

  test('a signed url that fails, or a dial that never opens, ends the conversation', async () => {
    const failing = harness(async () => {
      throw new Error('HTTP 401');
    });
    await failing.engine.start();
    expect(failing.ends).toEqual(['no_signed_url']);
    expect(
      failing.log.lines.some((l) => l.msg === 'speech engine: no signed url'),
    ).toBe(true);
    const slow = harness();
    await slow.engine.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(slow.sockets[0]?.closed?.code).toBe(4000);
    await settle();
    expect(slow.ends[0]).toBe('closed_4000');
  });
});

describe('the signed url', () => {
  test('asks the API with the key and the engine id', async () => {
    const calls: { url: string; key: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({
        url: String(input),
        key: new Headers(init?.headers).get('xi-api-key'),
      });
      return new Response(JSON.stringify({ signed_url: 'wss://signed' }));
    }) as typeof fetch;
    try {
      const url = await fetchSignedUrl(
        {
          api: 'https://api.test',
          engineId: 'seng_1',
          readKey: async () => 'k',
        },
        new AbortController().signal,
      );
      expect(url).toBe('wss://signed');
      expect(calls).toEqual([
        {
          url: 'https://api.test/v1/convai/conversation/get-signed-url?agent_id=seng_1',
          key: 'k',
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
