/**
 * One voice call: the connection to the owner's channel, the ears on the
 * owner, and the player. The library rejoins on its own after most socket
 * closes, so the call only caps those rejoins and ends on the close codes
 * that mean Discord wants the bot gone.
 */

import type { EventEmitter } from 'node:events';
import {
  joinVoiceChannel,
  VoiceConnectionDisconnectReason,
  type VoiceConnectionState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { RelayAdapter } from './adapter.ts';
import { Ears, type Receiver } from './ears.ts';
import type { Log } from './log.ts';
import { Playback, tone } from './playback.ts';
import type { CallState, CallStatus, StallReason } from './protocol.ts';

/** Close codes after which the library would rejoin forever, or must not. */
export const FINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4014, 4021, 4022,
]);

/** The slice of a VoiceConnection the call drives, so a test can fake one. */
export interface Connection extends EventEmitter {
  readonly state: VoiceConnectionState;
  readonly receiver: Receiver;
  rejoinAttempts: number;
  subscribe(player: Playback['player']): unknown;
  rejoin(): boolean;
  destroy(adapterAvailable?: boolean): void;
}

export type Connect = (options: {
  guildId: string;
  channelId: string;
  adapterCreator: RelayAdapter['creator'];
}) => Connection;

export const connectWithLibrary: Connect = (options) =>
  joinVoiceChannel({ ...options, selfDeaf: false, selfMute: false });

export interface CallOptions {
  guildId: string;
  channelId: string;
  ownerId: string;
  adapter: RelayAdapter;
  log: Log;
  joinTimeoutMs: number;
  rejoinCap: number;
  resubscribeCap: number;
  onState(state: CallState): void;
  onStall(reason: StallReason, code?: number): void;
  onFrame(opus: Buffer): void;
  connect?: Connect;
  playback?: Playback;
  /** Played once the connection is first ready; off in tests. */
  joinTone?: Buffer | null;
}

const JOIN_TONE = tone(880, 180);

export class Call {
  readonly playback: Playback;
  readonly adapter: RelayAdapter;
  private connection: Connection | null = null;
  private ears: Ears | null = null;
  private status: CallStatus = 'joining';
  private rejoins = 0;
  private networking: EventEmitter | null = null;
  private ended = false;

  constructor(private readonly options: CallOptions) {
    this.playback = options.playback ?? new Playback();
    this.adapter = options.adapter;
  }

  state(): CallState {
    return {
      guildId: this.options.guildId,
      channelId: this.options.channelId,
      ownerId: this.options.ownerId,
      status: this.status,
      ownerFrames: this.ears?.frames ?? 0,
      resubscribes: this.ears?.resubscribes ?? 0,
      rejoins: this.rejoins,
    };
  }

  /** Resolves once the connection is ready, or ends the call and throws. */
  async join(): Promise<void> {
    const { guildId, channelId, adapter, log } = this.options;
    const connect = this.options.connect ?? connectWithLibrary;
    const connection = connect({
      guildId,
      channelId,
      adapterCreator: adapter.creator,
    });
    this.connection = connection;
    this.ears = new Ears({
      receiver: connection.receiver,
      ownerId: this.options.ownerId,
      log,
      resubscribeCap: this.options.resubscribeCap,
      onFrame: this.options.onFrame,
      onStall: () => this.end('resubscribe_cap'),
    });
    connection.on('error', (error: Error) => {
      log.warn('voice connection error', { error: error.message });
    });
    connection.on('stateChange', (oldState, newState) =>
      this.onStateChange(oldState, newState),
    );
    connection.subscribe(this.playback.player);
    this.watchNetworking(connection.state);
    this.publish();
    const ready = await this.enters(VoiceConnectionStatus.Ready);
    if (!ready) {
      this.end('join_timeout');
      throw new Error('the voice connection did not become ready in time');
    }
  }

  /** Leaves the channel; the adapter sends the op 4 with a null channel. */
  leave(): void {
    this.end(null);
  }

  private onStateChange(
    oldState: VoiceConnectionState,
    newState: VoiceConnectionState,
  ): void {
    this.watchNetworking(newState);
    switch (newState.status) {
      case VoiceConnectionStatus.Ready: {
        const first = this.status === 'joining';
        this.status = 'ready';
        this.ears?.start();
        if (first && this.options.joinTone !== null) {
          this.playback.play(this.options.joinTone ?? JOIN_TONE);
        }
        this.options.log.info('voice connection ready', {
          rejoins: this.rejoins,
        });
        break;
      }
      case VoiceConnectionStatus.Signalling:
      case VoiceConnectionStatus.Connecting: {
        if (oldState.status === VoiceConnectionStatus.Signalling) break;
        if (this.status === 'joining') break;
        this.status = 'reconnecting';
        this.rejoins = Math.max(
          this.rejoins,
          this.connection?.rejoinAttempts ?? 0,
        );
        if (this.rejoins > this.options.rejoinCap) {
          this.end('rejoin_cap');
          return;
        }
        this.options.log.warn('voice connection rejoining', {
          rejoins: this.rejoins,
        });
        break;
      }
      case VoiceConnectionStatus.Disconnected: {
        if (
          newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
        ) {
          this.end('closed_by_discord', newState.closeCode);
          return;
        }
        if (
          newState.reason === VoiceConnectionDisconnectReason.AdapterUnavailable
        ) {
          this.end('adapter_lost');
          return;
        }
        if (this.rejoins >= this.options.rejoinCap) {
          this.end('rejoin_cap');
          return;
        }
        this.rejoins++;
        this.status = 'reconnecting';
        this.options.log.warn('voice connection dropped; rejoining', {
          reason: newState.reason,
          rejoins: this.rejoins,
        });
        if (!this.connection?.rejoin()) this.end('adapter_lost');
        break;
      }
      case VoiceConnectionStatus.Destroyed:
        this.end(null);
        return;
    }
    this.publish();
  }

  // The library turns every close but 4014 into a rejoin, 4021 and 4022
  // included, so the code is read off the networking instance itself.
  private watchNetworking(state: VoiceConnectionState): void {
    const networking =
      'networking' in state ? (state.networking as EventEmitter) : null;
    if (!networking || networking === this.networking) return;
    this.networking = networking;
    networking.on('close', (code: number) => {
      if (FINAL_CLOSE_CODES.has(code)) this.end('closed_by_discord', code);
    });
  }

  private enters(status: VoiceConnectionStatus): Promise<boolean> {
    const connection = this.connection;
    if (!connection) return Promise.resolve(false);
    if (connection.state.status === status) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        connection.off('stateChange', onChange);
        resolve(false);
      }, this.options.joinTimeoutMs);
      const onChange = (
        _old: VoiceConnectionState,
        state: VoiceConnectionState,
      ) => {
        if (state.status === status) {
          clearTimeout(timer);
          connection.off('stateChange', onChange);
          resolve(true);
        } else if (state.status === VoiceConnectionStatus.Destroyed) {
          clearTimeout(timer);
          connection.off('stateChange', onChange);
          resolve(false);
        }
      };
      connection.on('stateChange', onChange);
    });
  }

  private end(reason: StallReason | null, code?: number): void {
    if (this.ended) return;
    this.ended = true;
    this.status = 'destroyed';
    this.ears?.stop();
    this.playback.stop();
    const connection = this.connection;
    this.connection = null;
    if (
      connection &&
      connection.state.status !== VoiceConnectionStatus.Destroyed
    ) {
      connection.destroy(this.options.adapter.attached);
    }
    this.options.log.info('voice call ended', {
      reason: reason ?? 'left',
      code,
      ownerFrames: this.ears?.frames ?? 0,
      rejoins: this.rejoins,
    });
    if (reason) this.options.onStall(reason, code);
    this.publish();
  }

  private published = '';

  private publish(): void {
    const state = this.state();
    const key = JSON.stringify(state);
    if (key === this.published) return;
    this.published = key;
    this.options.onState(state);
  }
}
