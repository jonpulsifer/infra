/**
 * The wire protocol between mate and mate-voice, the bridge that holds the
 * Discord voice connection. mate listens and the bridge dials in over one
 * WebSocket; every message is one JSON text frame with a `type`. Both sides
 * send `heartbeat` on a fixed cadence and treat silence as a lost link.
 *
 * mate stays the only gateway session. The bridge's voice library asks for
 * gateway sends (op 4, to join or leave) through `gateway`, and mate relays
 * the bot's own `VOICE_STATE_UPDATE` and the `VOICE_SERVER_UPDATE` back as
 * `voice_state` and `voice_server`.
 *
 * `speak`, `announce`, `transcript` and `barge_in` are the speech half. They
 * are part of the schema so the two sides never drift, but the bridge only
 * counts them until speech lands.
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const snowflake = z.string().regex(/^\d{15,22}$/);

export const CallStatus = z.enum([
  'joining',
  'ready',
  'reconnecting',
  'destroyed',
]);
export type CallStatus = z.infer<typeof CallStatus>;

export const CallState = z.object({
  guildId: snowflake,
  channelId: snowflake,
  ownerId: snowflake,
  status: CallStatus,
  /** Opus frames heard from the owner since the join. */
  ownerFrames: z.number().int().nonnegative(),
  /** Times the owner's receive stream was rebuilt. */
  resubscribes: z.number().int().nonnegative(),
  rejoins: z.number().int().nonnegative(),
});
export type CallState = z.infer<typeof CallState>;

/** Gateway dispatch data is relayed as mate received it; the voice library parses it. */
const dispatch = z.looseObject({ guild_id: snowflake.optional() });

export const FromMate = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number().int() }),
  z.object({
    type: z.literal('join'),
    guildId: snowflake,
    channelId: snowflake,
    ownerId: snowflake,
  }),
  z.object({ type: z.literal('voice_state'), data: dispatch }),
  z.object({ type: z.literal('voice_server'), data: dispatch }),
  z.object({ type: z.literal('speak'), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal('announce'), text: z.string() }),
  z.object({ type: z.literal('stop_playback') }),
  z.object({ type: z.literal('leave') }),
  z.object({ type: z.literal('heartbeat') }),
]);
export type FromMate = z.infer<typeof FromMate>;

export const StallReason = z.enum([
  'join_timeout',
  'rejoin_cap',
  'resubscribe_cap',
  'closed_by_discord',
  'adapter_lost',
]);
export type StallReason = z.infer<typeof StallReason>;

export const FromBridge = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    protocol: z.number().int(),
    version: z.string(),
  }),
  /** A payload for mate to send on the gateway shard that holds the guild. */
  z.object({
    type: z.literal('gateway'),
    payload: z.looseObject({ op: z.number().int() }),
  }),
  z.object({ type: z.literal('state'), call: CallState.nullable() }),
  z.object({
    type: z.literal('transcript'),
    speakerId: snowflake,
    text: z.string(),
    final: z.boolean(),
  }),
  z.object({ type: z.literal('barge_in'), heardChars: z.number().int() }),
  z.object({
    type: z.literal('stall'),
    reason: StallReason,
    code: z.number().int().optional(),
  }),
  z.object({ type: z.literal('heartbeat') }),
]);
export type FromBridge = z.infer<typeof FromBridge>;

export function encode(message: FromBridge | FromMate): string {
  return JSON.stringify(message);
}

/** The message a text frame holds, or `null` for a frame that is not one. */
export function decodeFromMate(text: string): FromMate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = FromMate.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function decodeFromBridge(text: string): FromBridge | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = FromBridge.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
