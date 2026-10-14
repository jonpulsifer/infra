/**
 * The gateway adapter the voice library drives. The bridge has no gateway
 * session, so each payload the library wants sent goes to mate, which holds
 * the shard, and mate relays the two dispatches back.
 *
 * In @discordjs/voice 0.19.2 a `VOICE_SERVER_UPDATE` delivered before the
 * `VOICE_STATE_UPDATE` leaves the connection in `signalling` for good, so a
 * server update is held until a state update has been delivered.
 */
import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterLibraryMethods,
} from '@discordjs/voice';
import type { Log } from './log.ts';

type Dispatch = Record<string, unknown>;

export interface RelayAdapter {
  readonly creator: DiscordGatewayAdapterCreator;
  onVoiceStateUpdate(data: Dispatch): void;
  onVoiceServerUpdate(data: Dispatch): void;
  /** Whether the library still holds this adapter. */
  readonly attached: boolean;
  /** Called by the bridge when mate is gone; the library drops the connection. */
  destroy(): void;
}

export function relayAdapter(
  send: (payload: Dispatch) => boolean,
  log: Log,
): RelayAdapter {
  let methods: DiscordGatewayAdapterLibraryMethods | null = null;
  let stateDelivered = false;
  let heldServer: Dispatch | null = null;
  let relayed = 0;

  const adapter: RelayAdapter = {
    creator: (library) => {
      methods = library;
      stateDelivered = false;
      heldServer = null;
      return {
        sendPayload: (payload: Dispatch) => {
          relayed++;
          return send(payload);
        },
        destroy: () => {
          methods = null;
          heldServer = null;
        },
      };
    },
    onVoiceStateUpdate: (data) => {
      if (!methods) return;
      stateDelivered = true;
      methods.onVoiceStateUpdate(data as never);
      if (heldServer) {
        const server = heldServer;
        heldServer = null;
        methods.onVoiceServerUpdate(server as never);
        log.info('released the held voice server update');
      }
    },
    onVoiceServerUpdate: (data) => {
      if (!methods) return;
      if (!stateDelivered) {
        heldServer = data;
        return;
      }
      methods.onVoiceServerUpdate(data as never);
    },
    get attached() {
      return methods !== null;
    },
    destroy: () => {
      const library = methods;
      methods = null;
      heldServer = null;
      library?.destroy();
      log.info('gateway adapter destroyed', { relayed });
    },
  };
  return adapter;
}
