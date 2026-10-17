/**
 * The ears: one receive stream per person in the channel, each frame tagged
 * with who sent it. The owner's stream opens with the call; anyone else's
 * opens the first time Discord says they are transmitting. Attribution is
 * Discord's SSRC map, not authentication: whatever a microphone picks up
 * comes through its owner's stream.
 *
 * The library ends a receive stream when a decrypt error passes its
 * tolerance; the owner's is rebuilt a bounded number of times and then the
 * ears stall, while anyone else's is simply dropped past the cap.
 */

import type { Readable } from 'node:stream';
import { EndBehaviorType } from '@discordjs/voice';
import type { Log } from './log.ts';

export interface Receiver {
  subscribe(
    userId: string,
    options?: { end: { behavior: EndBehaviorType.Manual } },
  ): Readable;
  /** Who is transmitting, by user id: metadata the library keeps for every speaker. */
  speaking?: {
    on(event: 'start' | 'end', listener: (userId: string) => void): unknown;
  };
}

export interface EarsOptions {
  receiver: Receiver;
  ownerId: string;
  log: Log;
  /** Rebuilds of one person's stream before the ears give up on it. */
  resubscribeCap: number;
  onFrame(userId: string, opus: Buffer): void;
  /** The owner's stream is gone for good. */
  onStall(): void;
}

interface Subscription {
  stream: Readable | null;
  resubscribes: number;
  frames: number;
}

export class Ears {
  /** The owner's frames, for the call state. */
  frames = 0;
  /** Everyone else's frames. */
  otherFrames = 0;
  /** Rebuilds of the owner's stream. */
  resubscribes = 0;
  private readonly streams = new Map<string, Subscription>();
  private listening = false;

  constructor(private readonly options: EarsOptions) {}

  /** People with a stream open. */
  get speakers(): number {
    return this.streams.size;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.subscribe(this.options.ownerId);
    this.options.receiver.speaking?.on('start', (userId) => {
      if (this.listening && !this.streams.has(userId)) this.subscribe(userId);
    });
  }

  stop(): void {
    this.listening = false;
    for (const [userId, subscription] of this.streams) {
      const { stream } = subscription;
      subscription.stream = null;
      this.streams.delete(userId);
      if (stream && !stream.destroyed) stream.destroy();
    }
  }

  private subscribe(userId: string): void {
    const { receiver, ownerId, log } = this.options;
    const owner = userId === ownerId;
    const subscription: Subscription = this.streams.get(userId) ?? {
      stream: null,
      resubscribes: 0,
      frames: 0,
    };
    this.streams.set(userId, subscription);
    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    subscription.stream = stream;
    stream.on('data', (opus: Buffer) => {
      subscription.frames++;
      if (owner) this.frames++;
      else this.otherFrames++;
      this.options.onFrame(userId, opus);
    });
    stream.on('error', (error: Error) => {
      log.warn('receive stream failed', { owner, error: error.message });
    });
    stream.once('close', () => {
      if (subscription.stream !== stream) return;
      subscription.stream = null;
      if (!this.listening) return;
      if (subscription.resubscribes >= this.options.resubscribeCap) {
        if (owner) {
          log.warn('owner receive stream ended past the cap', {
            resubscribes: subscription.resubscribes,
          });
          this.listening = false;
          this.options.onStall();
        } else {
          log.warn('a receive stream ended past the cap; not rebuilt', {
            resubscribes: subscription.resubscribes,
          });
          this.streams.delete(userId);
        }
        return;
      }
      subscription.resubscribes++;
      if (owner) this.resubscribes = subscription.resubscribes;
      log.info('receive stream ended; resubscribing', {
        owner,
        resubscribes: subscription.resubscribes,
      });
      this.subscribe(userId);
    });
  }
}
