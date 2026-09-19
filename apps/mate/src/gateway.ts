import { Client } from '@discordjs/core';
import { REST } from '@discordjs/rest';
import {
  CompressionMethod,
  WebSocketManager,
  WebSocketShardEvents,
} from '@discordjs/ws';
import { GatewayCloseCodes, GatewayIntentBits } from 'discord-api-types/v10';
import type { Clock } from './clock.ts';
import { IdentifyBudget, type SessionStartLimit } from './guard.ts';
import type { Health } from './health.ts';
import type { Log } from './log.ts';
import type { SessionStore } from './session.ts';

export const INTENTS =
  GatewayIntentBits.Guilds |
  GatewayIntentBits.GuildMessages |
  GatewayIntentBits.MessageContent;

/** Configuration errors: reconnecting cannot fix them, so the process stops. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  GatewayCloseCodes.AuthenticationFailed,
  GatewayCloseCodes.InvalidShard,
  GatewayCloseCodes.ShardingRequired,
  GatewayCloseCodes.InvalidAPIVersion,
  GatewayCloseCodes.InvalidIntents,
  GatewayCloseCodes.DisallowedIntents,
]);

export const EXIT_FATAL_CLOSE = 1;
export const EXIT_IDENTIFY_CAP = 2;

export interface GatewayDeps {
  token: string;
  store: SessionStore;
  log: Log;
  health: Health;
  clock: Clock;
  onLimit?(limit: SessionStartLimit): void;
  /** Every close, fatal or not, before anything is done about it. */
  onClose?(code: number, fatal: boolean): void;
  exit(code: number): void;
}

export interface Gateway {
  client: Client;
  manager: WebSocketManager;
  rest: REST;
  budget: IdentifyBudget;
}

export function createGateway(deps: GatewayDeps): Gateway {
  const { log, health } = deps;
  const rest = new REST({ version: '10', timeout: 15_000 }).setToken(
    deps.token,
  );
  let manager: WebSocketManager;
  const budget = new IdentifyBudget({
    clock: deps.clock,
    log,
    fetchLimit: async () =>
      (await manager.fetchGatewayInformation(true)).session_start_limit,
    onLimit: deps.onLimit,
    onBreach: () => deps.exit(EXIT_IDENTIFY_CAP),
  });
  manager = new WebSocketManager({
    token: deps.token,
    intents: INTENTS,
    rest,
    compression: CompressionMethod.ZlibNative,
    buildIdentifyThrottler: async () => budget,
    retrieveSessionInfo: (shardId) => deps.store.retrieve(shardId),
    updateSessionInfo: (shardId, info) => deps.store.update(shardId, info),
  });

  manager.on(WebSocketShardEvents.Ready, () => {
    health.connected = true;
    log.info('gateway ready');
  });
  manager.on(WebSocketShardEvents.Resumed, () => {
    health.connected = true;
    log.info('gateway resumed');
  });
  manager.on(WebSocketShardEvents.Closed, (code) => {
    health.connected = false;
    const fatal = FATAL_CLOSE_CODES.has(code);
    // Counted before the exit, because `exit` is what flushes it: a close
    // code that never leaves the process cannot be alerted on.
    deps.onClose?.(code, fatal);
    if (fatal) {
      log.error('gateway closed with a non-recoverable code; exiting', {
        code,
      });
      deps.exit(EXIT_FATAL_CLOSE);
      return;
    }
    log.warn('gateway closed', { code });
  });
  manager.on(WebSocketShardEvents.Error, (error) => {
    log.error('gateway error', { error: error.message });
  });
  manager.on(WebSocketShardEvents.SocketError, (error) => {
    log.warn('socket error', { error: error.message });
  });

  const client = new Client({ rest, gateway: manager });
  return { client, manager, rest, budget };
}
