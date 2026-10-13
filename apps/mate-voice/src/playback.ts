/**
 * What the bridge plays into the channel: a queue of s16le 48 kHz stereo
 * clips through one audio player, flushed at once on stop. The library's
 * timer paces the 20 ms frames, so the queue only decides what comes next.
 */

import { Readable } from 'node:stream';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;

/** A sine clip, for the join tone and tests. */
export function tone(hz: number, ms: number, amplitude = 0.2): Buffer {
  const samples = Math.floor((SAMPLE_RATE * ms) / 1000);
  const pcm = Buffer.alloc(samples * CHANNELS * BYTES_PER_SAMPLE);
  const peak = Math.floor(amplitude * 32_767);
  for (let i = 0; i < samples; i++) {
    const value = Math.round(
      peak * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE),
    );
    for (let channel = 0; channel < CHANNELS; channel++) {
      pcm.writeInt16LE(value, (i * CHANNELS + channel) * BYTES_PER_SAMPLE);
    }
  }
  return pcm;
}

export class Playback {
  readonly player: AudioPlayer;
  private readonly queue: Buffer[] = [];
  played = 0;
  flushed = 0;

  constructor(player?: AudioPlayer) {
    this.player =
      player ??
      createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
      });
    this.player.on('stateChange', (_old, state) => {
      if (state.status === AudioPlayerStatus.Idle) this.next();
    });
  }

  get idle(): boolean {
    return (
      this.queue.length === 0 &&
      this.player.state.status === AudioPlayerStatus.Idle
    );
  }

  /** Queues a clip; it plays when the player is idle. */
  play(pcm: Buffer): void {
    this.queue.push(pcm);
    if (this.player.state.status === AudioPlayerStatus.Idle) this.next();
  }

  /** Drops the queue and stops the clip playing now. */
  stop(): void {
    this.flushed += this.queue.length;
    this.queue.length = 0;
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.flushed++;
      this.player.stop(true);
    }
  }

  private next(): void {
    const pcm = this.queue.shift();
    if (!pcm) return;
    this.played++;
    this.player.play(
      createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }),
    );
  }
}
