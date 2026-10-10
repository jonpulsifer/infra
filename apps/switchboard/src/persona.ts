import type { ConversationTurn } from './elevenlabs.ts';

/**
 * The persona leaves of an agent: the character, which is edited live and
 * snapshotted into git. The list mirrors `persona` in
 * clusters/offsite/apps/elevenlabs/reconcile.sh, which leaves these alone.
 */
export const PERSONA_AGENT_KEYS = [
  'first_message',
  'max_conversation_duration_message',
] as const;
export const PERSONA_TTS_KEYS = [
  'voice_id',
  'model_id',
  'stability',
  'similarity_boost',
  'speed',
  'expressive_mode',
  'suggested_audio_tags',
] as const;

export const PROMPT_MAX_LEN = 20_000;
export const MESSAGE_MAX_LEN = 500;
export const TAGS_MAX = 24;
export const TAG_MAX_LEN = 40;
export const TAG_DESCRIPTION_MAX_LEN = 200;
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;
const MODEL_ID = /^[a-z0-9_]{3,60}$/;

export interface AudioTag {
  readonly tag: string;
  readonly description: string;
}

export interface PersonaTts {
  readonly voice_id?: string;
  readonly model_id?: string;
  readonly stability?: number;
  readonly similarity_boost?: number;
  readonly speed?: number;
  readonly expressive_mode?: boolean;
  readonly suggested_audio_tags?: readonly AudioTag[];
}

/** The flat shape the persona routes read and accept. */
export interface Persona {
  readonly first_message?: string;
  readonly max_conversation_duration_message?: string;
  readonly prompt?: string;
  readonly tts?: PersonaTts;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/** The persona leaves of a live agent, as the API returned it. */
export function pickPersona(agent: unknown): Persona {
  const config = obj(obj(agent).conversation_config);
  const a = obj(config.agent);
  const tts = obj(config.tts);
  const picked: Record<string, unknown> = {};
  for (const key of PERSONA_AGENT_KEYS) {
    if (a[key] !== undefined) picked[key] = a[key];
  }
  const prompt = obj(a.prompt).prompt;
  if (prompt !== undefined) picked.prompt = prompt;
  const pickedTts: Record<string, unknown> = {};
  for (const key of PERSONA_TTS_KEYS) {
    if (tts[key] !== undefined) pickedTts[key] = tts[key];
  }
  if (Object.keys(pickedTts).length > 0) picked.tts = pickedTts;
  return picked as Persona;
}

export type Validation =
  | { readonly ok: true; readonly persona: Persona }
  | { readonly ok: false; readonly error: string };

function text(value: unknown, name: string, max: number): string | Error {
  if (typeof value !== 'string') return new Error(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return new Error(`${name} must not be empty`);
  if (trimmed.length > max) {
    return new Error(`${name} must be at most ${max} characters`);
  }
  return trimmed;
}

function unit(value: unknown, name: string, lo: number, hi: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return new Error(`${name} must be a number`);
  }
  if (value < lo || value > hi) {
    return new Error(`${name} must be between ${lo} and ${hi}`);
  }
  return value;
}

function tags(value: unknown): readonly AudioTag[] | Error {
  if (!Array.isArray(value)) {
    return new Error('tts.suggested_audio_tags must be an array');
  }
  if (value.length > TAGS_MAX) {
    return new Error(`tts.suggested_audio_tags holds at most ${TAGS_MAX}`);
  }
  const out: AudioTag[] = [];
  for (const entry of value) {
    const e = obj(entry);
    const tag = text(e.tag, 'tag', TAG_MAX_LEN);
    if (tag instanceof Error) return tag;
    const description = text(
      e.description,
      'tag description',
      TAG_DESCRIPTION_MAX_LEN,
    );
    if (description instanceof Error) return description;
    out.push({ tag, description });
  }
  return out;
}

/**
 * A persona patch from a request body: only persona keys, each the right
 * shape, and at least one of them. Any other key refuses the whole body,
 * so a tool or a limit can never ride in on this route.
 */
export function validatePersona(body: unknown): Validation {
  const b = obj(body);
  const persona: Record<string, unknown> = {};
  const allowed = new Set<string>([...PERSONA_AGENT_KEYS, 'prompt', 'tts']);
  for (const key of Object.keys(b)) {
    if (!allowed.has(key)) return { ok: false, error: `unknown key ${key}` };
  }
  for (const key of PERSONA_AGENT_KEYS) {
    if (b[key] === undefined) continue;
    const value = text(b[key], key, MESSAGE_MAX_LEN);
    if (value instanceof Error) return { ok: false, error: value.message };
    persona[key] = value;
  }
  if (b.prompt !== undefined) {
    const value = text(b.prompt, 'prompt', PROMPT_MAX_LEN);
    if (value instanceof Error) return { ok: false, error: value.message };
    persona.prompt = value;
  }
  if (b.tts !== undefined) {
    const t = obj(b.tts);
    const tts: Record<string, unknown> = {};
    const known = new Set<string>(PERSONA_TTS_KEYS);
    for (const key of Object.keys(t)) {
      if (!known.has(key))
        return { ok: false, error: `unknown key tts.${key}` };
    }
    const checks: [string, unknown][] = [
      [
        'voice_id',
        t.voice_id === undefined
          ? undefined
          : typeof t.voice_id === 'string' && VOICE_ID.test(t.voice_id)
            ? t.voice_id
            : new Error('tts.voice_id must be a voice id'),
      ],
      [
        'model_id',
        t.model_id === undefined
          ? undefined
          : typeof t.model_id === 'string' && MODEL_ID.test(t.model_id)
            ? t.model_id
            : new Error('tts.model_id must be a model id'),
      ],
      [
        'stability',
        t.stability === undefined
          ? undefined
          : unit(t.stability, 'tts.stability', 0, 1),
      ],
      [
        'similarity_boost',
        t.similarity_boost === undefined
          ? undefined
          : unit(t.similarity_boost, 'tts.similarity_boost', 0, 1),
      ],
      [
        'speed',
        t.speed === undefined
          ? undefined
          : unit(t.speed, 'tts.speed', 0.7, 1.2),
      ],
      [
        'expressive_mode',
        t.expressive_mode === undefined
          ? undefined
          : typeof t.expressive_mode === 'boolean'
            ? t.expressive_mode
            : new Error('tts.expressive_mode must be true or false'),
      ],
      [
        'suggested_audio_tags',
        t.suggested_audio_tags === undefined
          ? undefined
          : tags(t.suggested_audio_tags),
      ],
    ];
    for (const [key, value] of checks) {
      if (value instanceof Error) return { ok: false, error: value.message };
      if (value !== undefined) tts[key] = value;
    }
    if (Object.keys(tts).length === 0) {
      return { ok: false, error: 'tts names no leaf' };
    }
    persona.tts = tts;
  }
  if (Object.keys(persona).length === 0) {
    return { ok: false, error: 'no persona leaf given' };
  }
  return { ok: true, persona: persona as Persona };
}

/** The ElevenLabs PATCH body for a persona: the leaves in their nested places. */
export function toAgentPatch(persona: Persona): Json {
  const agent: Record<string, unknown> = {};
  for (const key of PERSONA_AGENT_KEYS) {
    if (persona[key] !== undefined) agent[key] = persona[key];
  }
  if (persona.prompt !== undefined) agent.prompt = { prompt: persona.prompt };
  const config: Record<string, unknown> = {};
  if (Object.keys(agent).length > 0) config.agent = agent;
  if (persona.tts) config.tts = { ...persona.tts };
  return { conversation_config: config };
}

/**
 * The desired JSON of an agent with its persona leaves set to `persona`:
 * what the snapshot commits. Everything else in the file is untouched.
 */
export function applyPersona(file: unknown, persona: Persona): Json {
  const out = structuredClone(obj(file));
  const config = obj(out.conversation_config);
  const agent = obj(config.agent);
  for (const key of PERSONA_AGENT_KEYS) {
    if (persona[key] !== undefined) agent[key] = persona[key];
  }
  if (persona.prompt !== undefined) {
    agent.prompt = { ...obj(agent.prompt), prompt: persona.prompt };
  }
  config.agent = agent;
  if (persona.tts) config.tts = { ...obj(config.tts), ...persona.tts };
  out.conversation_config = config;
  return out;
}

/** The audio tags the agent wrote into its turns, in order, for a rehearsal report. */
export function tagsUsed(transcript: readonly ConversationTurn[]): string[] {
  const used: string[] = [];
  for (const turn of transcript) {
    if (turn.role !== 'agent' || !turn.message) continue;
    for (const match of turn.message.matchAll(/\[([a-z][a-z ]{0,30})\]/g)) {
      used.push(match[1] as string);
    }
  }
  return used;
}

/** Two-space JSON with a trailing newline, the way the files in git are written. */
export function renderAgentFile(file: Json): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}
