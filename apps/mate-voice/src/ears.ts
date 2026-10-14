/**
 * The owner-SSRC gate: the bridge subscribes to the owner's stream and nobody
 * else's, so no other speaker's audio ever leaves the pod. The gate is
 * attribution, not authentication: Discord maps an SSRC to a user id, and
 * whatever the owner's microphone picks up comes through it.
 *
 * The library ends a receive stream when a decrypt error passes its
 * tolerance; the ears rebuild it a bounded number of times and then stall.
 */

import type { Readable } from 'node:stream';
import { EndBehaviorType } from '@discordjs/voice';
import type { Log } from './log.ts';

export interface Receiver {
  subscribe(
    userId: string,
    options?: { end: { behavior: EndBehaviorType.Manual } },
  ): Readable;
}

export interface EarsOptions {
  receiver: Receiver;
  ownerId: string;
  log: Log;
  /** Rebuilds of the owner's stream before the ears stall. */
  resubscribeCap: number;
  onFrame(opus: Buffer): void;
  onStall(): void;
}

export class Ears {
  frames = 0;
  resubscribes = 0;
  private stream: Readable | null = null;
  private listening = false;

  constructor(private readonly options: EarsOptions) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    this.subscribe();
  }

  stop(): void {
    this.listening = false;
    const stream = this.stream;
    this.stream = null;
    if (stream && !stream.destroyed) stream.destroy();
  }

  private subscribe(): void {
    const { receiver, ownerId, log } = this.options;
    const stream = receiver.subscribe(ownerId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    this.stream = stream;
    stream.on('data', (opus: Buffer) => {
      this.frames++;
      this.options.onFrame(opus);
    });
    stream.on('error', (error: Error) => {
      log.warn('owner receive stream failed', { error: error.message });
    });
    stream.once('close', () => {
      if (this.stream !== stream) return;
      this.stream = null;
      if (!this.listening) return;
      if (this.resubscribes >= this.options.resubscribeCap) {
        log.warn('owner receive stream ended past the cap', {
          resubscribes: this.resubscribes,
        });
        this.listening = false;
        this.options.onStall();
        return;
      }
      this.resubscribes++;
      log.info('owner receive stream ended; resubscribing', {
        resubscribes: this.resubscribes,
      });
      this.subscribe();
    });
  }
}
