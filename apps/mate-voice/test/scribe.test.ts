import { describe, expect, test } from 'bun:test';
import type { Decoder, EngineSocket } from '../src/engine.ts';
import {
  FRAMES_PER_CHUNK,
  SCRIBE_SAMPLE_RATE,
  ScribeEars,
  scribeUrl,
} from '../src/scribe.ts';
import { capturingLog } from './fakes.ts';

class FakeWebSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
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
  /** The server went away. */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' } as CloseEvent);
  }
}

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

function harness(redialCap = 2) {
  const sockets: FakeWebSocket[] = [];
  const waits: number[] = [];
  let now = 10_000;
  const ticks: (() => void)[] = [];
  const log = capturingLog();
  const partials: string[] = [];
  const commits: string[] = [];
  const ends: string[] = [];
  const dec = decoder();
  const ears = new ScribeEars({
    api: 'https://api.test',
    readKey: async () => 'k',
    connect: (url, headers) => {
      const socket = new FakeWebSocket(url, headers);
      sockets.push(socket);
      return socket as unknown as EngineSocket;
    },
    decoder: () => dec,
    log,
    connectTimeoutMs: 50,
    redialCap,
    redialMs: 10,
    now: () => now,
    setTicker: ((fn: () => void) => {
      ticks.push(fn);
      return ticks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearTicker: (() => {
      ticks.length = 0;
    }) as typeof clearInterval,
    setTimer: ((fn: () => void, ms: number) => {
      waits.push(ms);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    onPartial: (text) => partials.push(text),
    onCommitted: (text) => commits.push(text),
    onEnd: (reason) => ends.push(reason),
  });
  return {
    ears,
    sockets,
    log,
    partials,
    commits,
    ends,
    dec,
    waits,
    ticks,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the Scribe ears', () => {
  test('dials with the key in a header and the 48 kHz VAD session in the query', async () => {
    const h = harness();
    await h.ears.start();
    const socket = h.sockets[0];
    expect(socket?.headers).toEqual({ 'xi-api-key': 'k' });
    const url = new URL(socket?.url ?? '');
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/v1/speech-to-text/realtime');
    expect(url.searchParams.get('model_id')).toBe('scribe_v2_realtime');
    expect(url.searchParams.get('audio_format')).toBe('pcm_48000');
    expect(url.searchParams.get('commit_strategy')).toBe('vad');
    expect(url.searchParams.get('vad_silence_threshold_secs')).toBe('0.8');
    expect(scribeUrl('http://local:1')).toStartWith('ws://local:1/');
  });

  test('sends the owner as mono 100 ms chunks once open, and passes words on', async () => {
    const h = harness();
    await h.ears.start();
    const socket = h.sockets[0];
    h.ears.hear(Buffer.from([10]));
    socket?.open();
    for (let i = 0; i < FRAMES_PER_CHUNK; i++) h.ears.hear(Buffer.from([10]));
    const chunk = socket?.sent[0];
    expect(chunk).toMatchObject({
      message_type: 'input_audio_chunk',
      commit: false,
      sample_rate: SCRIBE_SAMPLE_RATE,
    });
    const pcm = Buffer.from(chunk?.audio_base_64 as string, 'base64');
    expect(pcm.length).toBe(FRAMES_PER_CHUNK * 960 * 2);
    expect(pcm.readInt16LE(0)).toBe(10);
    socket?.receive({ message_type: 'session_started', config: {} });
    socket?.receive({ message_type: 'partial_transcript', text: ' hel' });
    socket?.receive({ message_type: 'partial_transcript', text: '' });
    socket?.receive({ message_type: 'committed_transcript', text: 'hello ' });
    expect(h.partials).toEqual(['hel']);
    expect(h.commits).toEqual(['hello']);
    expect(h.ears.counts).toMatchObject({
      heardFrames: FRAMES_PER_CHUNK + 1,
      sentChunks: 1,
      partials: 1,
      commits: 1,
    });
  });

  test('fills the quiet with silent chunks, so the VAD can close an utterance', async () => {
    const h = harness();
    await h.ears.start();
    const socket = h.sockets[0];
    socket?.open();
    expect(h.ticks).toHaveLength(1);
    // Nothing sent yet and no time passed: no filler.
    h.ticks[0]?.();
    expect(socket?.sent).toHaveLength(0);
    h.advance(FRAMES_PER_CHUNK * 20);
    h.ticks[0]?.();
    const silent = socket?.sent[0];
    expect(silent).toMatchObject({ message_type: 'input_audio_chunk' });
    const pcm = Buffer.from(silent?.audio_base_64 as string, 'base64');
    expect(pcm.length).toBe(FRAMES_PER_CHUNK * 960 * 2);
    expect(pcm.every((byte) => byte === 0)).toBe(true);
    // Speech within the span holds the filler back.
    h.advance(50);
    for (let i = 0; i < FRAMES_PER_CHUNK; i++) h.ears.hear(Buffer.from([10]));
    h.advance(60);
    h.ticks[0]?.();
    expect(socket?.sent).toHaveLength(2);
    // A short tail of speech is flushed by the ticker rather than held.
    h.ears.hear(Buffer.from([10]));
    h.advance(100);
    h.ticks[0]?.();
    expect(socket?.sent).toHaveLength(3);
    expect(
      Buffer.from(socket?.sent[2]?.audio_base_64 as string, 'base64').length,
    ).toBe(960 * 2);
    expect(h.ears.counts).toMatchObject({ sentChunks: 2, silentChunks: 1 });
    h.ears.stop();
    expect(h.ticks).toHaveLength(0);
  });

  test('redials a dropped session up to the cap, then ends deaf', async () => {
    const h = harness(1);
    await h.ears.start();
    h.sockets[0]?.open();
    h.sockets[0]?.drop();
    await Bun.sleep(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.ears.counts.redials).toBe(1);
    h.sockets[1]?.open();
    expect(h.ears.open).toBe(true);
    h.sockets[1]?.drop();
    await Bun.sleep(1);
    expect(h.sockets).toHaveLength(2);
    expect(h.ends).toEqual(['redial_cap']);
    expect(h.dec.deleted).toBe(true);
    expect(h.waits).toEqual([10]);
  });

  test('logs server errors by type and stops cleanly without a redial', async () => {
    const h = harness();
    await h.ears.start();
    h.sockets[0]?.open();
    h.sockets[0]?.receive({
      message_type: 'insufficient_audio_activity',
      error: 'quiet',
    });
    expect(h.log.lines.find((l) => l.msg === 'scribe: error')).toMatchObject({
      type: 'insufficient_audio_activity',
    });
    h.ears.stop();
    expect(h.sockets[0]?.closed?.code).toBe(1000);
    expect(h.sockets).toHaveLength(1);
    expect(h.ends).toEqual(['stopped']);
  });

  test('ends when the key cannot be read', async () => {
    const ends: string[] = [];
    const ears = new ScribeEars({
      api: 'https://api.test',
      readKey: async () => {
        throw new Error('ENOENT');
      },
      connect: () => {
        throw new Error('unreachable');
      },
      decoder,
      log: capturingLog(),
      connectTimeoutMs: 50,
      redialCap: 1,
      onPartial: () => {},
      onCommitted: () => {},
      onEnd: (reason) => ends.push(reason),
    });
    await ears.start();
    expect(ends).toEqual(['no_key']);
  });
});
