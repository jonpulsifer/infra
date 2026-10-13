import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type {
  AudioPlayerStatus,
  DiscordGatewayAdapterImplementerMethods,
  DiscordGatewayAdapterLibraryMethods,
  VoiceConnectionState,
} from '@discordjs/voice';
import { VoiceConnectionStatus } from '@discordjs/voice';
import type { Connect, Connection } from '../src/call.ts';
import type { Log } from '../src/log.ts';

export const GUILD = '444444444444444444';
export const CHANNEL = '333333333333333333';
export const OWNER = '222222222222222222';

/** What the library would do with the adapter: take it, then ask for op 4. */
export class FakeConnection extends EventEmitter implements Connection {
  state: VoiceConnectionState;
  rejoinAttempts = 0;
  rejoins = 0;
  destroyed: boolean[] = [];
  subscribed = 0;
  readonly networking = new EventEmitter();
  readonly library: DiscordGatewayAdapterLibraryMethods;
  readonly implementer: DiscordGatewayAdapterImplementerMethods;
  readonly dispatches: string[] = [];
  readonly streams: PassThrough[] = [];
  readonly asked: string[] = [];
  readonly receiver = {
    subscribe: (userId: string) => {
      this.asked.push(userId);
      const stream = new PassThrough();
      this.streams.push(stream);
      return stream;
    },
  };

  constructor(
    adapterCreator: (
      methods: DiscordGatewayAdapterLibraryMethods,
    ) => DiscordGatewayAdapterImplementerMethods,
  ) {
    super();
    this.library = {
      onVoiceStateUpdate: () => this.dispatches.push('state'),
      onVoiceServerUpdate: () => this.dispatches.push('server'),
      destroy: () => this.dispatches.push('destroy'),
    };
    this.implementer = adapterCreator(this.library);
    this.state = {
      status: VoiceConnectionStatus.Signalling,
      adapter: this.implementer,
    };
    this.implementer.sendPayload({
      op: 4,
      d: { guild_id: GUILD, channel_id: CHANNEL },
    });
  }

  go(status: VoiceConnectionStatus, extra: Record<string, unknown> = {}): void {
    const old = this.state;
    const withNetworking =
      status === VoiceConnectionStatus.Ready ||
      status === VoiceConnectionStatus.Connecting;
    this.state = {
      status,
      adapter: this.implementer,
      ...(withNetworking ? { networking: this.networking } : {}),
      ...extra,
    } as VoiceConnectionState;
    this.emit('stateChange', old, this.state);
  }

  subscribe(): unknown {
    this.subscribed++;
    return {};
  }

  rejoin(): boolean {
    this.rejoins++;
    this.rejoinAttempts++;
    this.go(VoiceConnectionStatus.Signalling);
    return true;
  }

  destroy(adapterAvailable = true): void {
    this.destroyed.push(adapterAvailable);
    if (adapterAvailable)
      this.implementer.sendPayload({
        op: 4,
        d: { guild_id: GUILD, channel_id: null },
      });
    this.implementer.destroy();
    this.go(VoiceConnectionStatus.Destroyed);
  }
}

export function fakeConnect(): {
  connect: Connect;
  connections: FakeConnection[];
} {
  const connections: FakeConnection[] = [];
  const connect: Connect = ({ adapterCreator }) => {
    const connection = new FakeConnection(adapterCreator);
    connections.push(connection);
    return connection;
  };
  return { connect, connections };
}

/** A player that plays nothing: the test drives its state. */
export class FakePlayer extends EventEmitter {
  state: { status: AudioPlayerStatus } = {
    status: 'idle' as AudioPlayerStatus,
  };
  played = 0;
  stops: boolean[] = [];
  play(): void {
    this.played++;
    this.go('playing' as AudioPlayerStatus);
  }
  stop(force?: boolean): boolean {
    this.stops.push(Boolean(force));
    this.go('idle' as AudioPlayerStatus);
    return true;
  }
  go(status: AudioPlayerStatus): void {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
  }
}

export function capturingLog(): Log & {
  lines: { level: string; msg: string }[];
} {
  const lines: { level: string; msg: string }[] = [];
  return {
    lines,
    info: (msg) => lines.push({ level: 'info', msg }),
    warn: (msg) => lines.push({ level: 'warn', msg }),
    error: (msg) => lines.push({ level: 'error', msg }),
  };
}
