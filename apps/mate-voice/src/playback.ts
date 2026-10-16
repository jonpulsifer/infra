/**
 * What the bridge plays into the channel: a queue of s16le 48 kHz stereo
 * sounds through one audio player, flushed at once on stop. A sound is a
 * clip, whole when queued, or a stream, written as it arrives and played as
 * one resource so its chunks join up. The library's timer paces the 20 ms
 * frames, so the queue only decides what comes next.
 */

import { PassThrough, Readable } from 'node:stream';
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
export const BYTES_PER_MS = (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE) / 1000;
export const FRAME_BYTES = 20 * BYTES_PER_MS;
/** Audio a stream holds before it starts, so the next chunk is there before the first runs out. */
export const JITTER_MS = 160;
/** The underrun, in 20 ms frames, the player fills with silence before it lets a stream's resource go. */
export const MAX_MISSED_FRAMES = 50;
/** How long a drained stream with no new audio keeps what is queued behind it waiting. */
export const STALL_MS = 5_000;
/** Silent frames after a stream's last audio, so the listener's decoder does not smear the end. */
export const TAIL_FRAMES = 5;

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

/** One sound written as it arrives; it plays in its turn in the queue. */
export interface PlaybackStream {
  /** Audio that follows what was written before, s16le 48 kHz stereo. */
  write(pcm: Buffer): void;
  /** No more audio: what was written plays out. */
  end(): void;
  /** Drops what has not played, and stops it if it is playing. */
  abort(): void;
  /** Whether a write still plays: a stream that ended, was flushed or gave way takes none. */
  readonly open: boolean;
}

interface Stream {
  pending: Buffer[];
  pendingBytes: number;
  /** The playing resource's input; null while the stream waits for audio. */
  source: PassThrough | null;
  sourceBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
  stalled: boolean;
  ended: boolean;
  done: boolean;
}

type Item = Buffer | Stream;

export interface PlaybackOptions {
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export class Playback {
  readonly player: AudioPlayer;
  private readonly queue: Item[] = [];
  private current: Item | null = null;
  played = 0;
  flushed = 0;
  /** Streams that ran dry before their end. */
  underruns = 0;
  errors = 0;

  constructor(
    player?: AudioPlayer,
    private readonly options: PlaybackOptions = {},
  ) {
    this.player =
      player ??
      createAudioPlayer({
        behaviors: {
          noSubscriber: NoSubscriberBehavior.Pause,
          maxMissedFrames: MAX_MISSED_FRAMES,
        },
      });
    this.player.on('error', () => {
      this.errors++;
    });
    this.player.on('stateChange', (_old, state) => {
      if (state.status === AudioPlayerStatus.Idle) this.onIdle();
    });
  }

  get idle(): boolean {
    return (
      this.queue.length === 0 &&
      this.current === null &&
      this.player.state.status === AudioPlayerStatus.Idle
    );
  }

  /** Queues a clip; it plays when what is ahead of it is done. */
  play(pcm: Buffer): void {
    this.enqueue(pcm);
  }

  /** Queues a stream; its audio plays when what is ahead of it is done. */
  openStream(): PlaybackStream {
    const stream: Stream = {
      pending: [],
      pendingBytes: 0,
      source: null,
      sourceBytes: 0,
      timer: null,
      stalled: false,
      ended: false,
      done: false,
    };
    this.enqueue(stream);
    return {
      write: (pcm) => this.write(stream, pcm),
      end: () => this.end(stream),
      abort: () => this.abort(stream),
      get open() {
        return !stream.ended && !stream.done;
      },
    };
  }

  /** Drops the queue and the open streams, and stops what is playing now. */
  stop(): void {
    for (const item of this.queue) this.retire(item);
    this.flushed += this.queue.length;
    this.queue.length = 0;
    const current = this.current;
    if (!current) return;
    this.flushed++;
    this.retire(current);
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    } else {
      this.current = null;
    }
  }

  private enqueue(item: Item): void {
    this.queue.push(item);
    const current = this.current;
    if (current === null) this.next();
    else if (!Buffer.isBuffer(current) && current.stalled)
      this.giveWay(current);
  }

  private next(): void {
    const item = this.queue.shift() ?? null;
    this.current = item;
    if (!item) return;
    if (Buffer.isBuffer(item)) {
      this.played++;
      this.player.play(
        createAudioResource(Readable.from([item]), {
          inputType: StreamType.Raw,
        }),
      );
      return;
    }
    this.prime(item);
  }

  private onIdle(): void {
    const current = this.current;
    if (current && !Buffer.isBuffer(current) && !current.done) {
      current.source = null;
      if (!current.ended) {
        this.underruns++;
        this.prime(current);
        return;
      }
      current.done = true;
    }
    this.next();
  }

  private write(stream: Stream, pcm: Buffer): void {
    if (stream.ended || stream.done || pcm.length === 0) return;
    stream.stalled = false;
    if (stream.source) {
      stream.source.write(pcm);
      stream.sourceBytes += pcm.length;
      return;
    }
    stream.pending.push(pcm);
    stream.pendingBytes += pcm.length;
    if (this.current === stream) this.prime(stream);
  }

  private end(stream: Stream): void {
    if (stream.ended || stream.done) return;
    stream.ended = true;
    if (stream.source) this.closeSource(stream);
    else if (this.current === stream) this.prime(stream);
  }

  private abort(stream: Stream): void {
    if (stream.done) return;
    this.retire(stream);
    if (this.current !== stream) {
      const at = this.queue.indexOf(stream);
      if (at !== -1) this.queue.splice(at, 1);
      return;
    }
    this.flushed++;
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    } else {
      this.next();
    }
  }

  /** The current stream, with no resource playing: start it, or wait for audio. */
  private prime(stream: Stream): void {
    this.clearTimer(stream);
    if (stream.ended || stream.pendingBytes >= JITTER_MS * BYTES_PER_MS) {
      this.start(stream);
      return;
    }
    const setTimer = this.options.setTimer ?? setTimeout;
    if (stream.pendingBytes > 0) {
      stream.timer = setTimer(() => {
        stream.timer = null;
        if (this.current === stream && !stream.source) this.start(stream);
      }, JITTER_MS);
      return;
    }
    stream.timer = setTimer(() => {
      stream.timer = null;
      stream.stalled = true;
      if (this.queue.length > 0) this.giveWay(stream);
    }, STALL_MS);
  }

  private start(stream: Stream): void {
    this.clearTimer(stream);
    if (stream.pendingBytes === 0) {
      stream.done = true;
      this.next();
      return;
    }
    const source = new PassThrough();
    const pcm = Buffer.concat(stream.pending);
    stream.pending = [];
    stream.pendingBytes = 0;
    stream.source = source;
    stream.sourceBytes = pcm.length;
    source.write(pcm);
    if (stream.ended) this.closeSource(stream);
    this.played++;
    this.player.play(
      createAudioResource(source, {
        inputType: StreamType.Raw,
        silencePaddingFrames: 0,
      }),
    );
  }

  /** Ends the source on a whole frame, since the encoder drops a part one, then the tail. */
  private closeSource(stream: Stream): void {
    const part = stream.sourceBytes % FRAME_BYTES;
    const pad = (part ? FRAME_BYTES - part : 0) + TAIL_FRAMES * FRAME_BYTES;
    stream.source?.end(Buffer.alloc(pad));
  }

  /** A drained stream steps aside for what is queued, and takes no more audio. */
  private giveWay(stream: Stream): void {
    this.retire(stream);
    this.next();
  }

  private retire(item: Item): void {
    if (Buffer.isBuffer(item)) return;
    this.clearTimer(item);
    item.pending = [];
    item.pendingBytes = 0;
    item.ended = true;
    item.done = true;
  }

  private clearTimer(stream: Stream): void {
    if (stream.timer) (this.options.clearTimer ?? clearTimeout)(stream.timer);
    stream.timer = null;
  }
}
