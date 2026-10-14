import { describe, expect, test } from 'bun:test';
import { type AudioPlayer, AudioPlayerStatus } from '@discordjs/voice';
import { CHANNELS, Playback, SAMPLE_RATE, tone } from '../src/playback.ts';
import { FakePlayer } from './fakes.ts';

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
});
