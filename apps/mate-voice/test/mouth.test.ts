import { describe, expect, test } from 'bun:test';
import type { AudioPlayer } from '@discordjs/voice';
import type { EngineSocket } from '../src/engine.ts';
import { Mouth, TTS_OUTPUT_RATE, ttsUrl } from '../src/mouth.ts';
import { FRAME_BYTES, Playback, TAIL_FRAMES } from '../src/playback.ts';
import { capturingLog, FakePlayer, readyFrames } from './fakes.ts';

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
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: '' } as CloseEvent);
  }
  /** Messages for one context, less the keepalive context's. */
  of(id: string) {
    return this.sent.filter((m) => m.context_id === id);
  }
}

function harness() {
  const sockets: FakeWebSocket[] = [];
  const player = new FakePlayer();
  const playbackTimers: (() => void)[] = [];
  const playback = new Playback(player as unknown as AudioPlayer, {
    setTimer: ((fn: () => void) => {
      playbackTimers.push(fn);
      return playbackTimers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  });
  const log = capturingLog();
  const timers: (() => void)[] = [];
  const mouth = new Mouth({
    api: 'https://api.test',
    voiceId: 'B3MaEpg3jVTwjxbDmLJE',
    modelId: 'eleven_flash_v2_5',
    voiceSettings: { stability: 0.5 },
    readKey: async () => 'k',
    connect: (url, headers) => {
      const socket = new FakeWebSocket(url, headers);
      sockets.push(socket);
      // The fake opens on the next tick, as a real socket would.
      queueMicrotask(() => socket.open());
      return socket as unknown as EngineSocket;
    },
    playback,
    log,
    connectTimeoutMs: 50,
    setTimer: ((fn: () => void) => {
      timers.push(fn);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {}) as typeof clearTimeout,
  });
  return { mouth, sockets, player, playback, log, timers };
}

/** 200 ms of 24 kHz mono by default: more than the jitter buffer holds. */
const audio = (contextId: string, samples = 4_800) => ({
  audio: Buffer.alloc(samples * 2, 1).toString('base64'),
  contextId,
});

describe('the mouth', () => {
  test('dials once on the first word, with the key, the voice, the model and 24 kHz pcm', async () => {
    const h = harness();
    await h.mouth.say('Hello ', false);
    const socket = h.sockets[0];
    expect(socket?.headers).toEqual({ 'xi-api-key': 'k' });
    const url = new URL(socket?.url ?? '');
    expect(url.pathname).toBe(
      '/v1/text-to-speech/B3MaEpg3jVTwjxbDmLJE/multi-stream-input',
    );
    expect(url.searchParams.get('model_id')).toBe('eleven_flash_v2_5');
    expect(url.searchParams.get('output_format')).toBe(
      `pcm_${TTS_OUTPUT_RATE}`,
    );
    expect(url.searchParams.get('auto_mode')).toBe('true');
    expect(ttsUrl('https://api.test', 'v', 'm')).toStartWith('wss://api.test/');
    expect(socket?.sent[0]).toEqual({
      context_id: 'keep',
      text: ' ',
      voice_settings: { stability: 0.5 },
    });
  });

  test('speaks an utterance as one context: init, words at boundaries, flush and close at the end', async () => {
    const h = harness();
    await h.mouth.say('Hello th', false);
    await h.mouth.say('ere, ow', false);
    await h.mouth.say('ner.', true);
    const socket = h.sockets[0];
    expect(socket?.of('u1')).toEqual([
      { context_id: 'u1', text: ' ', voice_settings: { stability: 0.5 } },
      { context_id: 'u1', text: 'Hello ' },
      { context_id: 'u1', text: 'there, ' },
      { context_id: 'u1', text: 'owner. ' },
      { context_id: 'u1', text: '', flush: true },
      { context_id: 'u1', close_context: true },
    ]);
    expect(h.mouth.counts).toMatchObject({ utterances: 1, chars: 20 });
    await h.mouth.say('Again.', true);
    expect(socket?.of('u2').map((m) => m.text ?? m.close_context)).toEqual([
      ' ',
      'Again. ',
      '',
      true,
    ]);
    expect(h.sockets).toHaveLength(1);
  });

  test("plays an utterance's chunks as one stream, upsampled to 48 kHz stereo", async () => {
    const h = harness();
    await h.mouth.say('Hi there.', true);
    h.sockets[0]?.receive(audio('u1'));
    expect(h.player.played).toBe(1);
    for (let i = 0; i < 9; i++) {
      await Bun.sleep(0);
      h.sockets[0]?.receive(audio('u1', 240));
    }
    h.sockets[0]?.receive({ isFinal: true, contextId: 'u1' });
    expect(h.player.played).toBe(1);
    expect(h.mouth.counts.audioChunks).toBe(10);
    // Each 24 kHz mono sample is two 48 kHz stereo frames of four bytes.
    const bytes = (4_800 + 9 * 240) * 8;
    expect(await readyFrames(h.player.resources[0])).toBe(
      Math.ceil(bytes / FRAME_BYTES) + TAIL_FRAMES,
    );
    expect(h.mouth.speaking).toBe(true);
    h.player.go('idle' as never);
    expect(h.mouth.speaking).toBe(false);
  });

  test('plays utterances in turn, an announcement included', async () => {
    const h = harness();
    await h.mouth.say('First.', true);
    await h.mouth.announce('Second.');
    h.sockets[0]?.receive(audio('u2'));
    h.sockets[0]?.receive(audio('u1'));
    expect(h.player.played).toBe(1);
    h.sockets[0]?.receive({ isFinal: true, contextId: 'u2' });
    h.sockets[0]?.receive({ isFinal: true, contextId: 'u1' });
    h.player.go('idle' as never);
    expect(h.player.played).toBe(2);
    expect(await readyFrames(h.player.resources[0])).toBe(
      (4_800 * 8) / FRAME_BYTES + TAIL_FRAMES,
    );
  });

  test('a hush closes the context, stops the player and drops the audio still arriving', async () => {
    const h = harness();
    await h.mouth.say('A long sentence ', false);
    h.sockets[0]?.receive(audio('u1'));
    expect(h.player.played).toBe(1);
    expect(h.mouth.speaking).toBe(true);
    expect(h.mouth.heardChars).toBe(16);
    h.mouth.hush();
    expect(h.sockets[0]?.of('u1').at(-1)).toEqual({
      context_id: 'u1',
      close_context: true,
    });
    expect(h.player.stops).toEqual([true]);
    h.sockets[0]?.receive(audio('u1'));
    expect(h.player.played).toBe(1);
    expect(h.mouth.counts).toMatchObject({ hushes: 1, droppedChunks: 1 });
    expect(h.mouth.speaking).toBe(false);
    h.sockets[0]?.receive({ isFinal: true, contextId: 'u1' });
    await h.mouth.say('Next.', true);
    h.sockets[0]?.receive(audio('u2'));
    expect(h.player.played).toBe(2);
  });

  test('a hush also drops the late audio of an utterance already said', async () => {
    const h = harness();
    await h.mouth.say('Done talking.', true);
    h.sockets[0]?.receive(audio('u1'));
    expect(h.mouth.speaking).toBe(true);
    h.mouth.hush();
    expect(h.player.stops).toEqual([true]);
    h.sockets[0]?.receive(audio('u1'));
    expect(h.player.played).toBe(1);
    expect(h.mouth.counts).toMatchObject({ hushes: 1, droppedChunks: 1 });
  });

  test('a socket that drops mid-utterance ends the stream with what came', async () => {
    const h = harness();
    await h.mouth.say('Cut ', false);
    h.sockets[0]?.receive(audio('u1'));
    h.sockets[0]?.drop();
    expect(await readyFrames(h.player.resources[0])).toBe(
      (4_800 * 8) / FRAME_BYTES + TAIL_FRAMES,
    );
    h.player.go('idle' as never);
    expect(h.player.played).toBe(1);
    expect(h.mouth.speaking).toBe(false);
  });

  test('redials on the next word after the socket drops, and counts a lost utterance', async () => {
    const h = harness();
    await h.mouth.say('Hello ', false);
    h.sockets[0]?.drop();
    expect(h.mouth.counts.failures).toBe(1);
    await h.mouth.say('world.', true);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.of('u2').map((m) => m.text)).toEqual([
      ' ',
      'world. ',
      '',
      undefined,
    ]);
    expect(h.mouth.counts.dials).toBe(2);
  });

  test('a redial while the old socket is still closing ends its utterances, so the next one plays', async () => {
    const h = harness();
    await h.mouth.say('Hello ', false);
    h.sockets[0]?.receive(audio('u1'));
    expect(h.player.played).toBe(1);
    // The server sent a close frame; onclose has not fired yet.
    const old = h.sockets[0];
    if (!old) throw new Error('no socket');
    old.readyState = 2;
    await h.mouth.say('world.', true);
    expect(h.sockets).toHaveLength(2);
    expect(h.mouth.counts.failures).toBe(1);
    old.onclose?.({ code: 1006, reason: '' } as CloseEvent);
    h.sockets[1]?.receive(audio('u2'));
    h.player.go('idle' as never);
    expect(h.player.played).toBe(2);
    expect(h.mouth.speaking).toBe(true);
    h.sockets[1]?.receive({ isFinal: true, contextId: 'u2' });
  });

  test('keeps the socket alive between turns and stops cleanly', async () => {
    const h = harness();
    await h.mouth.say('Hi.', true);
    // The connect timer and the keepalive; the last one is the keepalive.
    expect(h.timers).toHaveLength(2);
    h.timers.at(-1)?.();
    expect(h.sockets[0]?.sent.at(-1)).toEqual({ context_id: 'keep', text: '' });
    h.mouth.stop();
    h.mouth.stop();
    expect(h.sockets[0]?.sent.at(-1)).toEqual({ close_socket: true });
    expect(h.sockets[0]?.closed?.code).toBe(1000);
    expect(h.log.lines.filter((l) => l.msg.startsWith('tts: s'))).toEqual([
      { level: 'info', msg: 'tts: socket open', dials: 1 },
      {
        level: 'info',
        msg: 'tts: stopped',
        utterances: 1,
        chars: 4,
        audioChunks: 0,
        droppedChunks: 0,
        hushes: 0,
        dials: 1,
        failures: 0,
        underruns: 0,
      },
    ]);
    await h.mouth.say('Nothing.', true);
    expect(h.sockets).toHaveLength(1);
  });
});
