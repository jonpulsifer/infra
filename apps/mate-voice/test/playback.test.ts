import { describe, expect, test } from 'bun:test';
import { type AudioPlayer, AudioPlayerStatus } from '@discordjs/voice';
import {
  BYTES_PER_MS,
  CHANNELS,
  FRAME_BYTES,
  JITTER_MS,
  Playback,
  SAMPLE_RATE,
  STALL_MS,
  TAIL_FRAMES,
  tone,
} from '../src/playback.ts';
import { FakePlayer, readyFrames } from './fakes.ts';

function harness() {
  const player = new FakePlayer();
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const playback = new Playback(player as unknown as AudioPlayer, {
    setTimer: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms, cleared: false });
      return timers.at(-1) as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: ((timer: { cleared: boolean }) => {
      timer.cleared = true;
    }) as unknown as typeof clearTimeout,
  });
  /** Fires the live timer of that length set last. */
  const fire = (ms: number) => {
    const timer = timers.filter((t) => !t.cleared && t.ms === ms).at(-1);
    if (!timer) throw new Error(`no ${ms} ms timer`);
    timer.cleared = true;
    timer.fn();
  };
  return { player, playback, timers, fire };
}

const ms = (n: number) => Buffer.alloc(n * BYTES_PER_MS, 1);

describe('tone', () => {
  test('is 20 ms of 48 kHz stereo s16le per 20 ms asked', () => {
    const pcm = tone(440, 20);
    expect(pcm.length).toBe((SAMPLE_RATE / 50) * CHANNELS * 2);
    expect(pcm.readInt16LE(0)).toBe(0);
    expect(pcm.readInt16LE(2)).toBe(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 2) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    }
    expect(peak).toBeGreaterThan(6_000);
    expect(peak).toBeLessThanOrEqual(6_554);
  });
});

describe('playback', () => {
  test('plays clips one after another and flushes on stop', () => {
    const player = new FakePlayer();
    const playback = new Playback(player as unknown as AudioPlayer);
    expect(playback.idle).toBe(true);
    playback.play(tone(440, 20));
    playback.play(tone(440, 20));
    playback.play(tone(440, 20));
    expect(player.played).toBe(1);
    expect(playback.idle).toBe(false);
    player.go(AudioPlayerStatus.Idle);
    expect(player.played).toBe(2);
    playback.stop();
    expect(player.stops).toEqual([true]);
    expect(playback.flushed).toBe(2);
    expect(player.played).toBe(2);
    expect(playback.idle).toBe(true);
    playback.stop();
    expect(player.stops).toEqual([true]);
  });

  test('plays a stream written in small chunks as one resource, with no gap frames', async () => {
    const { player, playback } = harness();
    const stream = playback.openStream();
    stream.write(ms(JITTER_MS));
    expect(player.played).toBe(1);
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(0);
      stream.write(ms(25));
    }
    stream.end();
    expect(stream.open).toBe(false);
    expect(player.played).toBe(1);
    const bytes = (JITTER_MS + 12 * 25) * BYTES_PER_MS;
    expect(await readyFrames(player.resources[0])).toBe(
      Math.ceil(bytes / FRAME_BYTES) + TAIL_FRAMES,
    );
    expect(player.resources[0]?.silencePaddingFrames).toBe(0);
    player.go(AudioPlayerStatus.Idle);
    expect(playback.idle).toBe(true);
    expect(playback.underruns).toBe(0);
  });

  test('holds a stream until the jitter buffer fills, its timer fires or it ends', () => {
    const { player, playback, fire } = harness();
    const first = playback.openStream();
    first.write(ms(40));
    first.write(ms(40));
    expect(player.played).toBe(0);
    expect(playback.idle).toBe(false);
    fire(JITTER_MS);
    expect(player.played).toBe(1);
    first.end();
    player.go(AudioPlayerStatus.Idle);
    const second = playback.openStream();
    second.write(ms(20));
    second.end();
    expect(player.played).toBe(2);
  });

  test('a queued clip and a stream wait their turn, either way round', () => {
    const { player, playback } = harness();
    playback.play(tone(880, 180));
    const stream = playback.openStream();
    stream.write(ms(JITTER_MS));
    expect(player.played).toBe(1);
    player.go(AudioPlayerStatus.Idle);
    expect(player.played).toBe(2);
    playback.play(tone(880, 20));
    stream.write(ms(20));
    expect(player.played).toBe(2);
    stream.end();
    expect(player.played).toBe(2);
    player.go(AudioPlayerStatus.Idle);
    expect(player.played).toBe(3);
    player.go(AudioPlayerStatus.Idle);
    expect(playback.idle).toBe(true);
  });

  test('a stream that runs dry waits for more on a new resource, and gives way when it stalls', () => {
    const { player, playback, fire } = harness();
    const stream = playback.openStream();
    stream.write(ms(JITTER_MS));
    player.go(AudioPlayerStatus.Idle);
    expect(playback.underruns).toBe(1);
    expect(stream.open).toBe(true);
    stream.write(ms(JITTER_MS));
    expect(player.played).toBe(2);
    player.go(AudioPlayerStatus.Idle);
    playback.play(tone(880, 20));
    expect(player.played).toBe(2);
    fire(STALL_MS);
    expect(stream.open).toBe(false);
    expect(player.played).toBe(3);
    stream.write(ms(JITTER_MS));
    expect(player.played).toBe(3);
  });

  test('a stream that never hears audio gives way on its own, so the player is idle again', () => {
    const { player, playback, fire } = harness();
    const stream = playback.openStream();
    expect(playback.idle).toBe(false);
    fire(STALL_MS);
    expect(stream.open).toBe(false);
    expect(playback.idle).toBe(true);
    expect(player.played).toBe(0);
  });

  test('stop and abort drop open streams and what they hold', () => {
    const { player, playback } = harness();
    const playing = playback.openStream();
    playing.write(ms(JITTER_MS));
    const queued = playback.openStream();
    queued.write(ms(JITTER_MS));
    playback.stop();
    expect(player.stops).toEqual([true]);
    expect(playback.flushed).toBe(2);
    expect(playing.open).toBe(false);
    expect(queued.open).toBe(false);
    expect(playback.idle).toBe(true);
    queued.write(ms(JITTER_MS));
    expect(player.played).toBe(1);
    const aborted = playback.openStream();
    aborted.write(ms(JITTER_MS));
    const next = playback.openStream();
    next.write(ms(JITTER_MS));
    aborted.abort();
    expect(player.stops).toEqual([true, true]);
    expect(player.played).toBe(3);
    next.end();
  });
});
