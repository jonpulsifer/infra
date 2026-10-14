/**
 * The bridge's state machine over the link: at most one call, driven by
 * mate's messages, with the link's loss bounded by a timer after which the
 * call ends on its own. `main.ts` wires it to the process.
 */

import { type FromMate, PROTOCOL_VERSION } from '@repo/mate-voice-protocol';
import { relayAdapter } from './adapter.ts';
import { Call, type Connect } from './call.ts';
import type { Config } from './config.ts';
import type { MateLink } from './link.ts';
import type { Log } from './log.ts';
import type { Playback } from './playback.ts';

export const VERSION = '0.1.0';

export interface BridgeDeps {
  config: Config;
  link: Pick<MateLink, 'send'>;
  log: Log;
  connect?: Connect;
  playback?: () => Playback;
  joinTone?: Buffer | null;
}

export class Bridge {
  private call: Call | null = null;
  private orphan: ReturnType<typeof setTimeout> | null = null;
  /** Speech characters mate has sent that nothing voices yet. */
  unvoicedChars = 0;

  constructor(private readonly deps: BridgeDeps) {}

  get inCall(): boolean {
    return this.call !== null;
  }

  onLinkOpen(): void {
    if (this.orphan) clearTimeout(this.orphan);
    this.orphan = null;
    this.deps.link.send({
      type: 'ready',
      protocol: PROTOCOL_VERSION,
      version: VERSION,
    });
    if (this.call)
      this.deps.link.send({ type: 'state', call: this.call.state() });
  }

  onLinkClose(): void {
    if (!this.call || this.orphan) return;
    this.orphan = setTimeout(() => {
      this.orphan = null;
      this.deps.log.warn('mate unreachable; leaving the call', {
        orphanMs: this.deps.config.orphanMs,
      });
      this.call?.leave();
    }, this.deps.config.orphanMs);
  }

  async onMessage(message: FromMate): Promise<void> {
    const { log } = this.deps;
    switch (message.type) {
      case 'hello':
        if (message.protocol !== PROTOCOL_VERSION) {
          log.error('mate speaks another protocol', {
            mate: message.protocol,
            bridge: PROTOCOL_VERSION,
          });
        }
        return;
      case 'join':
        await this.join(message);
        return;
      case 'voice_state':
        this.call?.adapter.onVoiceStateUpdate(message.data);
        return;
      case 'voice_server':
        this.call?.adapter.onVoiceServerUpdate(message.data);
        return;
      case 'speak':
      case 'announce':
        this.unvoicedChars += message.text.length;
        return;
      case 'stop_playback':
        this.call?.playback.stop();
        return;
      case 'leave':
        this.call?.leave();
        return;
      case 'heartbeat':
        return;
    }
  }

  stop(): void {
    if (this.orphan) clearTimeout(this.orphan);
    this.orphan = null;
    this.call?.leave();
  }

  private async join(
    message: Extract<FromMate, { type: 'join' }>,
  ): Promise<void> {
    const { config, link, log } = this.deps;
    if (this.call) {
      log.warn('join while in a call; leaving the old one first');
      this.call.leave();
    }
    const adapter = relayAdapter(
      (payload) => link.send({ type: 'gateway', payload: payload as never }),
      log,
    );
    const call = new Call({
      guildId: message.guildId,
      channelId: message.channelId,
      ownerId: message.ownerId,
      adapter,
      log,
      joinTimeoutMs: config.joinTimeoutMs,
      rejoinCap: config.rejoinCap,
      resubscribeCap: config.resubscribeCap,
      onState: (state) => {
        link.send({ type: 'state', call: state });
        if (state.status === 'destroyed' && this.call === call) {
          this.call = null;
          link.send({ type: 'state', call: null });
        }
      },
      onStall: (reason, code) => link.send({ type: 'stall', reason, code }),
      // Decoding and speech-to-text land with the speech half.
      onFrame: () => {},
      connect: this.deps.connect,
      playback: this.deps.playback?.(),
      joinTone: this.deps.joinTone,
    });
    this.call = call;
    try {
      await call.join();
    } catch (error) {
      log.warn('join failed', { error: (error as Error).message });
    }
  }
}
