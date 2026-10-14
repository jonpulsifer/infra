/**
 * mate's side of the voice bridge. mate stays the only gateway session: the
 * bridge dials mate's `/voice` WebSocket, asks for each gateway send through
 * it, and mate relays the bot's own voice state and the voice server update
 * back. At most one call is open, in the voice channel the owner is in.
 *
 * mate leaves when the owner leaves the channel, when the channel empties,
 * and when the bridge goes quiet; the bridge leaves on its own when mate is
 * gone for too long.
 */
import {
  type CallState as BridgeCallState,
  decodeFromBridge,
  encode,
  type FromBridge,
  type FromMate,
  PROTOCOL_VERSION,
} from '@repo/mate-voice-protocol';
import type {
  APIBaseVoiceState,
  GatewayOpcodes,
  GatewaySendPayload,
  GatewayVoiceServerUpdateDispatchData,
} from 'discord-api-types/v10';
import type { Clock, Handle } from './clock.ts';
import { type Log, plain } from './log.ts';

export const VOICE_PATH = '/voice';
/** The bridge beats at the same cadence; three missed beats end the link. */
export const HEARTBEAT_MS = 5_000;
export const QUIET_BEATS = 3;
/** Codes mate closes the link with. */
export const CLOSE_QUIET = 4000;
export const CLOSE_REPLACED = 4001;
export const CLOSE_PROTOCOL = 4002;
export const CLOSE_RESTARTING = 1001;

/** One bridge connection, as mate sees it. */
export interface LinkSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export interface VoiceGateway {
  /** Sends a payload on the shard that holds mate's guild. */
  send(payload: GatewaySendPayload): Promise<void>;
}

export interface Call {
  guildId: string;
  channelId: string;
  ownerId: string;
  /** The text channel the join came from, where status lines go. */
  originChannelId: string | null;
  status: BridgeCallState['status'];
}

export type JoinRefusal =
  | 'not_allowed'
  | 'bridge_not_ready'
  | 'not_in_voice'
  | 'channel_not_allowed'
  | 'already_there';

export type JoinResult = { ok: true } | { ok: false; reason: JoinRefusal };
export type LeaveResult =
  | { ok: true }
  | { ok: false; reason: 'not_allowed' | 'no_call' };

export interface VoiceOptions {
  guildId: string;
  allowedUserIds: ReadonlySet<string>;
  allowedChannelIds: ReadonlySet<string>;
  gateway: VoiceGateway;
  clock: Clock;
  log: Log;
  /** A status line for the humans in the text channel the call came from. */
  post(channelId: string, line: string): Promise<void>;
  heartbeatMs?: number;
}

const REFUSALS: Record<JoinRefusal | 'no_call', string> = {
  not_allowed: 'voice is for the owner',
  bridge_not_ready: 'the voice bridge is not connected',
  not_in_voice: 'join a voice channel first',
  channel_not_allowed: 'that voice channel is not one I may join',
  already_there: "I'm already in your channel",
  no_call: "I'm not in a call",
};

export function refusalLine(reason: JoinRefusal | 'no_call'): string {
  return REFUSALS[reason];
}

export class Voice {
  private socket: LinkSocket | null = null;
  private bridgeReady = false;
  private call: Call | null = null;
  private me = '';
  /** Who is in which voice channel of the guild, from the gateway. */
  private readonly channels = new Map<string, string | null>();
  private beat: Handle | null = null;
  private lastHeard = 0;
  private readonly heartbeatMs: number;
  /** Counts only; the words never reach a log. */
  private transcriptChars = 0;
  private bargeIns = 0;

  constructor(private readonly options: VoiceOptions) {
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  get ready(): boolean {
    return this.bridgeReady && this.socket !== null;
  }

  get current(): Call | null {
    return this.call;
  }

  /** The bot user, known at READY. On a fresh identify a held call is rejoined. */
  async onReady(me: string): Promise<void> {
    this.me = me;
    const call = this.call;
    if (!call) return;
    this.options.log.info('voice: fresh gateway session; rejoining the call');
    await this.sendVoiceState(call.guildId, call.channelId);
  }

  /** The guild's voice states as GUILD_CREATE lists them. */
  onGuildCreate(states: readonly APIBaseVoiceState[] | undefined): void {
    this.channels.clear();
    for (const state of states ?? [])
      this.channels.set(state.user_id, state.channel_id);
  }

  async onVoiceStateUpdate(
    data: APIBaseVoiceState & { guild_id?: string },
  ): Promise<void> {
    if (data.guild_id !== undefined && data.guild_id !== this.options.guildId)
      return;
    this.channels.set(data.user_id, data.channel_id);
    if (data.user_id === this.me) {
      this.send({ type: 'voice_state', data: data as never });
    }
    const call = this.call;
    if (!call) return;
    if (data.user_id === call.ownerId && data.channel_id !== call.channelId) {
      await this.leaveCall('the owner left the channel');
      return;
    }
    if (this.others(call.channelId) === 0) {
      await this.leaveCall('the channel is empty');
    }
  }

  onVoiceServerUpdate(data: GatewayVoiceServerUpdateDispatchData): void {
    if (data.guild_id !== this.options.guildId) return;
    this.send({ type: 'voice_server', data: data as never });
  }

  /** Puts mate in the voice channel the user is in. */
  async join(
    userId: string,
    originChannelId: string | null,
  ): Promise<JoinResult> {
    const { allowedUserIds, allowedChannelIds, guildId, log } = this.options;
    if (!allowedUserIds.has(userId))
      return { ok: false, reason: 'not_allowed' };
    if (!this.ready) return { ok: false, reason: 'bridge_not_ready' };
    const channelId = this.channels.get(userId) ?? null;
    if (!channelId) return { ok: false, reason: 'not_in_voice' };
    if (!allowedChannelIds.has(channelId))
      return { ok: false, reason: 'channel_not_allowed' };
    if (this.call?.channelId === channelId && this.call.status !== 'destroyed')
      return { ok: false, reason: 'already_there' };
    this.call = {
      guildId,
      channelId,
      ownerId: userId,
      originChannelId,
      status: 'joining',
    };
    this.send({ type: 'join', guildId, channelId, ownerId: userId });
    log.info('voice: joining', { channelId });
    return { ok: true };
  }

  async leave(userId: string): Promise<LeaveResult> {
    if (!this.options.allowedUserIds.has(userId))
      return { ok: false, reason: 'not_allowed' };
    if (!this.call) return { ok: false, reason: 'no_call' };
    await this.leaveCall('asked to');
    return { ok: true };
  }

  /** A bridge connected; a second one replaces the first. */
  attach(socket: LinkSocket): void {
    const previous = this.socket;
    if (previous) {
      this.options.log.warn('voice: a second bridge dialled in; replacing');
      this.socket = null;
      previous.close(CLOSE_REPLACED, 'replaced');
    }
    this.socket = socket;
    this.bridgeReady = false;
    this.lastHeard = this.options.clock.now();
    this.startBeat();
    this.send({ type: 'hello', protocol: PROTOCOL_VERSION });
    this.options.log.info('voice: bridge linked');
  }

  async receive(socket: LinkSocket, text: string): Promise<void> {
    if (socket !== this.socket) return;
    this.lastHeard = this.options.clock.now();
    const message = decodeFromBridge(text);
    if (!message) {
      this.options.log.warn('voice: the bridge sent an unknown message');
      return;
    }
    await this.handle(message);
  }

  /** The bridge's socket closed, by either side. */
  async detach(socket: LinkSocket): Promise<void> {
    if (socket !== this.socket) return;
    this.socket = null;
    this.bridgeReady = false;
    this.stopBeat();
    const call = this.call;
    this.options.log.warn('voice: bridge link lost', { inCall: call !== null });
    if (!call) return;
    // The bridge cannot ask for the leave any more, so mate sends it itself.
    this.call = null;
    await this.sendVoiceState(call.guildId, null);
    await this.tell(call, 'the voice bridge went away, so I left the call');
  }

  /** mate is restarting: the bridge keeps the call for the next process. */
  async stop(): Promise<void> {
    const call = this.call;
    if (call) await this.tell(call, 'restarting; back in a moment');
    const socket = this.socket;
    this.socket = null;
    this.bridgeReady = false;
    this.stopBeat();
    socket?.close(CLOSE_RESTARTING, 'mate restarting');
  }

  private async handle(message: FromBridge): Promise<void> {
    const { log } = this.options;
    switch (message.type) {
      case 'ready':
        if (message.protocol !== PROTOCOL_VERSION) {
          log.error('voice: the bridge speaks another protocol', {
            bridge: message.protocol,
            mate: PROTOCOL_VERSION,
          });
          this.socket?.close(CLOSE_PROTOCOL, 'protocol');
          return;
        }
        this.bridgeReady = true;
        log.info('voice: bridge ready', { version: message.version });
        return;
      case 'gateway':
        await this.options.gateway
          .send(message.payload as unknown as GatewaySendPayload)
          .catch((error) =>
            log.warn('voice: gateway send failed', { error: plain(error) }),
          );
        return;
      case 'state':
        await this.onState(message.call);
        return;
      case 'stall': {
        const call = this.call;
        this.call = null;
        log.warn('voice: the bridge stalled', {
          reason: message.reason,
          code: message.code ?? null,
        });
        if (call) await this.tell(call, `voice stalled: ${message.reason}`);
        return;
      }
      case 'transcript':
        this.transcriptChars += message.text.length;
        return;
      case 'barge_in':
        this.bargeIns += 1;
        return;
      case 'heartbeat':
        return;
    }
  }

  private async onState(state: BridgeCallState | null): Promise<void> {
    const { log } = this.options;
    if (state === null) {
      const ended = this.call;
      this.call = null;
      if (ended) {
        log.info('voice: call over');
        await this.tell(ended, 'left the voice channel');
      }
      return;
    }
    const call = this.call;
    // The old call's last state, when a join replaced it on the bridge.
    if (
      call &&
      call.channelId !== state.channelId &&
      state.status === 'destroyed'
    )
      return;
    if (!call || call.channelId !== state.channelId) {
      // The bridge held a call across a mate restart.
      log.info('voice: adopting the call the bridge holds', {
        channelId: state.channelId,
        status: state.status,
      });
      this.call = {
        guildId: state.guildId,
        channelId: state.channelId,
        ownerId: state.ownerId,
        originChannelId: call?.originChannelId ?? null,
        status: state.status,
      };
      return;
    }
    const was = call.status;
    call.status = state.status;
    if (was !== state.status) {
      log.info('voice: call state', {
        status: state.status,
        ownerFrames: state.ownerFrames,
        rejoins: state.rejoins,
        resubscribes: state.resubscribes,
      });
      if (state.status === 'ready' && was === 'joining')
        await this.tell(call, 'joined the voice channel');
    }
  }

  private async leaveCall(why: string): Promise<void> {
    const call = this.call;
    if (!call) return;
    this.options.log.info('voice: leaving', { why });
    if (this.ready) {
      this.send({ type: 'leave' });
      return;
    }
    this.call = null;
    await this.sendVoiceState(call.guildId, null);
  }

  /** Members of the channel other than mate. */
  private others(channelId: string): number {
    let count = 0;
    for (const [userId, inChannel] of this.channels) {
      if (inChannel === channelId && userId !== this.me) count += 1;
    }
    return count;
  }

  private async sendVoiceState(
    guildId: string,
    channelId: string | null,
  ): Promise<void> {
    const payload = {
      op: 4 as GatewayOpcodes.VoiceStateUpdate,
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: false,
        self_deaf: false,
      },
    };
    await this.options.gateway.send(payload).catch((error) =>
      this.options.log.warn('voice: gateway send failed', {
        error: plain(error),
      }),
    );
  }

  private send(message: FromMate): boolean {
    const socket = this.socket;
    if (!socket) return false;
    try {
      socket.send(encode(message));
      return true;
    } catch (error) {
      this.options.log.warn('voice: send to the bridge failed', {
        error: plain(error),
      });
      return false;
    }
  }

  private async tell(call: Call, line: string): Promise<void> {
    if (!call.originChannelId) return;
    await this.options.post(call.originChannelId, line).catch((error) =>
      this.options.log.warn('voice: status post failed', {
        error: plain(error),
      }),
    );
  }

  private startBeat(): void {
    this.stopBeat();
    const { clock } = this.options;
    const tick = () => {
      this.beat = clock.after(this.heartbeatMs, tick);
      const socket = this.socket;
      if (!socket) return;
      if (clock.now() - this.lastHeard > this.heartbeatMs * QUIET_BEATS) {
        this.options.log.warn('voice: bridge quiet; closing the link', {
          quietMs: this.heartbeatMs * QUIET_BEATS,
        });
        socket.close(CLOSE_QUIET, 'quiet');
        // Bun reports the close back through `detach`; a fake may not.
        return;
      }
      this.send({ type: 'heartbeat' });
    };
    this.beat = clock.after(this.heartbeatMs, tick);
  }

  private stopBeat(): void {
    if (this.beat) this.options.clock.cancel(this.beat);
    this.beat = null;
  }
}

/** `join` or `leave` when a message to mate is only that word. */
export function voiceCommand(
  content: string,
  me: string,
): 'join' | 'leave' | null {
  const word = content
    .replace(new RegExp(`<@!?${me}>`, 'g'), '')
    .trim()
    .toLowerCase();
  return word === 'join' || word === 'leave' ? word : null;
}

export interface VoiceSocketData {
  link: LinkSocket | null;
}

/** Bun's handlers for the `/voice` upgrade. */
export function voiceHandlers(
  voice: Voice,
): Bun.WebSocketHandler<VoiceSocketData> {
  return {
    open(ws) {
      const link: LinkSocket = {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
      };
      ws.data.link = link;
      voice.attach(link);
    },
    message(ws, data) {
      const link = ws.data.link;
      if (!link || typeof data !== 'string') return;
      void voice.receive(link, data);
    },
    close(ws) {
      const link = ws.data.link;
      ws.data.link = null;
      if (link) void voice.detach(link);
    },
  };
}
