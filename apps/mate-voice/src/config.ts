export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface Config {
  /** mate's bridge endpoint, a ws(s) URL inside the namespace. */
  readonly mateUrl: string;
  readonly port: number;
  readonly heartbeatMs: number;
  readonly connectTimeoutMs: number;
  readonly joinTimeoutMs: number;
  /** Rejoins in one call before the bridge gives up and leaves. */
  readonly rejoinCap: number;
  /** Rebuilds of the owner's receive stream before the bridge leaves. */
  readonly resubscribeCap: number;
  /** How long a call outlives the link to mate before the bridge leaves. */
  readonly orphanMs: number;
  /** How a call hears and speaks; `null` leaves it silent. */
  readonly speech: SpeechConfig | null;
}

/**
 * `native`: the bridge runs Scribe and text-to-speech itself and mate's
 * brain answers over the link. `engine`: ElevenLabs Speech Engine does the
 * hearing and speaking and dials mate's brain over the public tunnel.
 */
export type SpeechConfig = NativeSpeechConfig | EngineSpeechConfig;

export interface NativeSpeechConfig {
  readonly mode: 'native';
  readonly api: string;
  /** Read on every dial, so a rotated key needs no restart. */
  readonly keyFile: string;
  readonly voiceId: string;
  readonly ttsModel: string;
  /** Redials of the Scribe session in one call before the call goes deaf. */
  readonly scribeRedialCap: number;
}

export interface EngineSpeechConfig {
  readonly mode: 'engine';
  readonly api: string;
  readonly keyFile: string;
  /** `seng_…`, the engine the reconciler created. */
  readonly engineId: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ConfigError(`${key} is required`);
  return value;
}

function integer(env: Env, key: string, fallback: number, min = 1): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new ConfigError(
      `${key} must be an integer of at least ${min}, got ${raw}`,
    );
  }
  return value;
}

function wsUrl(env: Env, key: string): string {
  const raw = required(env, key);
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {}
  if (!url || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) {
    throw new ConfigError(`${key} must be a ws(s) URL, got ${raw}`);
  }
  return raw;
}

export function readConfig(env: Env): Config {
  return {
    mateUrl: wsUrl(env, 'MATE_VOICE_MATE_URL'),
    port: integer(env, 'MATE_VOICE_PORT', 8080),
    heartbeatMs: integer(env, 'MATE_VOICE_HEARTBEAT_MS', 5_000, 100),
    connectTimeoutMs: integer(
      env,
      'MATE_VOICE_CONNECT_TIMEOUT_MS',
      10_000,
      100,
    ),
    joinTimeoutMs: integer(env, 'MATE_VOICE_JOIN_TIMEOUT_MS', 20_000, 1_000),
    rejoinCap: integer(env, 'MATE_VOICE_REJOIN_CAP', 3, 0),
    resubscribeCap: integer(env, 'MATE_VOICE_RESUBSCRIBE_CAP', 5, 0),
    orphanMs: integer(env, 'MATE_VOICE_ORPHAN_MS', 30_000, 1_000),
    speech: speech(env),
  };
}

const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

function speech(env: Env): SpeechConfig | null {
  const engineId = env.MATE_VOICE_ELEVENLABS_ENGINE_ID?.trim() ?? '';
  const voiceId = env.MATE_VOICE_ELEVENLABS_VOICE_ID?.trim() ?? '';
  const keyFile = env.MATE_VOICE_ELEVENLABS_KEY_FILE?.trim() ?? '';
  if (!engineId && !voiceId && !keyFile) return null;
  if (engineId && voiceId) {
    throw new ConfigError(
      'MATE_VOICE_ELEVENLABS_VOICE_ID (native speech) and MATE_VOICE_ELEVENLABS_ENGINE_ID (Speech Engine) exclude each other',
    );
  }
  if (!keyFile || (!engineId && !voiceId)) {
    throw new ConfigError(
      'MATE_VOICE_ELEVENLABS_KEY_FILE goes with MATE_VOICE_ELEVENLABS_VOICE_ID or MATE_VOICE_ELEVENLABS_ENGINE_ID',
    );
  }
  const api =
    env.MATE_VOICE_ELEVENLABS_API?.trim() || 'https://api.elevenlabs.io';
  let url: URL | null = null;
  try {
    url = new URL(api);
  } catch {}
  if (url?.protocol !== 'https:') {
    throw new ConfigError(
      `MATE_VOICE_ELEVENLABS_API must be an https URL, got ${api}`,
    );
  }
  if (voiceId) {
    if (!VOICE_ID.test(voiceId)) {
      throw new ConfigError(
        `MATE_VOICE_ELEVENLABS_VOICE_ID must be a voice id, got ${voiceId}`,
      );
    }
    return {
      mode: 'native',
      api,
      keyFile,
      voiceId,
      ttsModel:
        env.MATE_VOICE_ELEVENLABS_TTS_MODEL?.trim() || 'eleven_flash_v2_5',
      scribeRedialCap: integer(env, 'MATE_VOICE_SCRIBE_REDIAL_CAP', 5, 0),
    };
  }
  if (!engineId.startsWith('seng_')) {
    throw new ConfigError(
      `MATE_VOICE_ELEVENLABS_ENGINE_ID must be a speech engine id (seng_…), got ${engineId}`,
    );
  }
  return { mode: 'engine', api, keyFile, engineId };
}
