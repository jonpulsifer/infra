import { describe, expect, test } from 'bun:test';
import {
  applyPersona,
  pickPersona,
  renderAgentFile,
  tagsUsed,
  toAgentPatch,
  validatePersona,
} from '../src/persona.ts';

const liveAgent = {
  agent_id: 'agent_1',
  name: 'pbx-troll',
  conversation_config: {
    agent: {
      language: 'en',
      first_message: 'Yeah. Who is this?',
      max_conversation_duration_message: 'Gotta go.',
      prompt: {
        prompt: 'You are Jonathan.',
        llm: 'gemini-3.5-flash-lite',
        temperature: 0.7,
      },
    },
    tts: {
      model_id: 'eleven_v4_turbo',
      voice_id: 'B3MaEpg3jVTwjxbDmLJE',
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 0.95,
      expressive_mode: true,
      suggested_audio_tags: [{ tag: 'annoyed', description: 'Lightly.' }],
      optimize_streaming_latency: 3,
    },
    turn: { turn_timeout: 10 },
  },
  platform_settings: { call_limits: { daily_limit: 20 } },
};

describe('pickPersona', () => {
  test('takes the persona leaves and nothing else', () => {
    expect(pickPersona(liveAgent)).toEqual({
      first_message: 'Yeah. Who is this?',
      max_conversation_duration_message: 'Gotta go.',
      prompt: 'You are Jonathan.',
      tts: {
        voice_id: 'B3MaEpg3jVTwjxbDmLJE',
        model_id: 'eleven_v4_turbo',
        stability: 0.5,
        similarity_boost: 0.75,
        speed: 0.95,
        expressive_mode: true,
        suggested_audio_tags: [{ tag: 'annoyed', description: 'Lightly.' }],
      },
    });
  });

  test('an agent with no persona leaves is an empty persona', () => {
    expect(pickPersona({ name: 'x' })).toEqual({});
    expect(pickPersona(null)).toEqual({});
  });
});

describe('validatePersona', () => {
  test('accepts a partial persona and trims it', () => {
    const checked = validatePersona({
      prompt: '  You are grumpy.  ',
      tts: {
        stability: 0.6,
        suggested_audio_tags: [{ tag: 'sighs', description: 'Once.' }],
      },
    });
    expect(checked).toEqual({
      ok: true,
      persona: {
        prompt: 'You are grumpy.',
        tts: {
          stability: 0.6,
          suggested_audio_tags: [{ tag: 'sighs', description: 'Once.' }],
        },
      },
    });
  });

  test('refuses a key that is not a persona leaf, whole', () => {
    for (const body of [
      { prompt: 'x', llm: 'gpt' },
      { prompt: 'x', tts: { stability: 0.5, optimize_streaming_latency: 3 } },
      { platform_settings: { call_limits: { daily_limit: 999 } } },
      { conversation_config: { agent: { prompt: { prompt: 'x' } } } },
    ]) {
      const checked = validatePersona(body);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.error).toMatch(/^unknown key/);
    }
  });

  test('refuses the wrong shape for a leaf', () => {
    const cases: [unknown, string][] = [
      [{}, 'no persona leaf given'],
      [{ prompt: '' }, 'prompt must not be empty'],
      [
        { prompt: 'x'.repeat(20_001) },
        'prompt must be at most 20000 characters',
      ],
      [{ first_message: 7 }, 'first_message must be a string'],
      [{ tts: {} }, 'tts names no leaf'],
      [{ tts: { stability: 1.5 } }, 'tts.stability must be between 0 and 1'],
      [{ tts: { speed: '1' } }, 'tts.speed must be a number'],
      [{ tts: { voice_id: 'not a voice' } }, 'tts.voice_id must be a voice id'],
      [
        { tts: { expressive_mode: 'yes' } },
        'tts.expressive_mode must be true or false',
      ],
      [
        { tts: { suggested_audio_tags: [{ tag: 'x' }] } },
        'tag description must be a string',
      ],
      [
        { tts: { suggested_audio_tags: 'sighs' } },
        'tts.suggested_audio_tags must be an array',
      ],
    ];
    for (const [body, error] of cases) {
      expect(validatePersona(body)).toEqual({ ok: false, error });
    }
  });
});

describe('toAgentPatch', () => {
  test('nests the leaves where the API keeps them and carries nothing else', () => {
    expect(
      toAgentPatch({
        first_message: 'Hey.',
        prompt: 'Be short.',
        tts: { stability: 0.6 },
      }),
    ).toEqual({
      conversation_config: {
        agent: { first_message: 'Hey.', prompt: { prompt: 'Be short.' } },
        tts: { stability: 0.6 },
      },
    });
    expect(toAgentPatch({ tts: { speed: 0.9 } })).toEqual({
      conversation_config: { tts: { speed: 0.9 } },
    });
  });
});

describe('applyPersona', () => {
  test('writes the persona into the file and leaves the rest alone', () => {
    const file = {
      name: 'pbx-troll',
      conversation_config: {
        agent: {
          first_message: 'old',
          prompt: { prompt: 'old prompt', llm: 'gemini-3.5-flash-lite' },
        },
        tts: { voice_id: 'old', stability: 0.4 },
        turn: { turn_timeout: 10 },
      },
      platform_settings: { data_collection: {} },
    };
    const next = applyPersona(file, {
      first_message: 'new',
      prompt: 'new prompt',
      tts: { stability: 0.6, speed: 0.9 },
    });
    expect(next).toEqual({
      name: 'pbx-troll',
      conversation_config: {
        agent: {
          first_message: 'new',
          prompt: { prompt: 'new prompt', llm: 'gemini-3.5-flash-lite' },
        },
        tts: { voice_id: 'old', stability: 0.6, speed: 0.9 },
        turn: { turn_timeout: 10 },
      },
      platform_settings: { data_collection: {} },
    });
    expect(file.conversation_config.agent.first_message).toBe('old');
  });

  test('renders two-space JSON with a trailing newline', () => {
    expect(renderAgentFile({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe('tagsUsed', () => {
  test('lists the agent tags in order and ignores the caller', () => {
    expect(
      tagsUsed([
        { role: 'agent', message: '[annoyed] What. [short pause] Go on.' },
        { role: 'user', message: '[laughs] Hi!' },
        { role: 'agent', message: 'Yeah.' },
        { role: 'agent', message: '[sighs] Right.' },
      ]),
    ).toEqual(['annoyed', 'short pause', 'sighs']);
  });
});
