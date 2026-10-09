import { afterEach, describe, expect, test } from 'bun:test';
import type { Conversation } from '../src/elevenlabs.ts';
import {
  defaultName,
  MAX_RESULTS,
  MissionStore,
  POLL_LIMIT,
  parseKeyword,
  pollAndScore,
  scoreConversation,
} from '../src/mission.ts';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe('parseKeyword', () => {
  test('accepts letters, spaces, hyphens and apostrophes, trimmed', () => {
    expect(parseKeyword('  otter ')).toBe('otter');
    expect(parseKeyword("rock-n-roll o'clock")).toBe("rock-n-roll o'clock");
  });

  test('refuses empty, long, non-string and punctuated keywords', () => {
    const bad = ['', '   ', 'a'.repeat(41), 'ot7er', 'a.b', "'", 42, null];
    for (const value of bad) expect(parseKeyword(value)).toBeUndefined();
    expect(parseKeyword('a'.repeat(40))).toBe('a'.repeat(40));
  });
});

test('defaultName upper-cases the first letter', () => {
  expect(defaultName('sam')).toBe('Sam');
});

const convo = (
  transcript: Conversation['transcript'],
  extra: Partial<Conversation> = {},
): Conversation => ({ status: 'done', transcript, ...extra });

describe('scoreConversation', () => {
  test('a user turn with the keyword wins, with its turn and time', () => {
    const result = scoreConversation(
      convo([
        { role: 'agent', message: 'Hello there', time_in_call_secs: 1 },
        { role: 'user', message: 'Hi', time_in_call_secs: 4 },
        { role: 'user', message: 'An OTTER, you say.', time_in_call_secs: 9 },
      ]),
      'otter',
    );
    expect(result).toMatchObject({
      won: true,
      turn: 2,
      secondsToWin: 9,
      agentSaidFirst: false,
    });
  });

  test('a plural counts, a longer word does not', () => {
    const win = (message: string) =>
      scoreConversation(
        convo([{ role: 'user', message, time_in_call_secs: 1 }]),
        'fox',
      ).won;
    expect(win('two foxes')).toBe(true);
    expect(win('foxs')).toBe(true);
    expect(win('foxy lady')).toBe(false);
    expect(win('a firefox')).toBe(false);
  });

  test('a word ending in y counts as its -ies plural', () => {
    const win = (message: string) =>
      scoreConversation(
        convo([{ role: 'user', message, time_in_call_secs: 1 }]),
        'blueberry',
      ).won;
    expect(win('Blueberries.')).toBe(true);
    expect(win('a blueberry')).toBe(true);
    expect(win('blueberrys')).toBe(false);
    expect(win('blueberried')).toBe(false);
  });

  test('a multi-word keyword matches across spacing', () => {
    expect(
      scoreConversation(
        convo([
          { role: 'user', message: 'Ice   Cream!', time_in_call_secs: 2 },
        ]),
        'ice cream',
      ).won,
    ).toBe(true);
  });

  test('the agent saying it first is no win, even if the user repeats it', () => {
    const result = scoreConversation(
      convo([
        { role: 'agent', message: 'Do you like otters?', time_in_call_secs: 2 },
        { role: 'user', message: 'Otters, sure.', time_in_call_secs: 5 },
      ]),
      'otter',
    );
    expect(result.won).toBe(false);
    expect(result.agentSaidFirst).toBe(true);
    expect(result.turn).toBeUndefined();
  });

  test('no mention at all, and null messages, are no win', () => {
    const result = scoreConversation(
      convo([
        { role: 'agent', message: null, time_in_call_secs: 0 },
        { role: 'user', message: 'Nothing', time_in_call_secs: 3 },
      ]),
      'otter',
    );
    expect(result).toMatchObject({ won: false, agentSaidFirst: false });
  });

  test('carries the analysis and duration when present', () => {
    const result = scoreConversation(
      convo([], {
        metadata: { call_duration_secs: 61 },
        analysis: {
          evaluation_criteria_results: {
            fair_play: { result: 'success' },
            keyword_won: { result: 'failure' },
          },
          data_collection_results: {
            winning_line: { value: 'It was an otter' },
            how_it_happened: { value: 'Small talk' },
          },
        },
      }),
      'otter',
    );
    expect(result).toMatchObject({
      fairPlay: 'success',
      keywordWon: 'failure',
      winningLine: 'It was an otter',
      howItHappened: 'Small talk',
      durationSecs: 61,
    });
  });

  test('leaves the analysis fields undefined when absent', () => {
    const result = scoreConversation(convo([]), 'otter');
    expect(result.fairPlay).toBeUndefined();
    expect(result.winningLine).toBeUndefined();
    expect(result.durationSecs).toBeUndefined();
  });
});

describe('pollAndScore', () => {
  const statuses = (...list: string[]) => {
    const urls: string[] = [];
    let i = 0;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const status = list[Math.min(i++, list.length - 1)];
      return Response.json({
        status,
        transcript: [{ role: 'user', message: 'otter', time_in_call_secs: 3 }],
      });
    }) as unknown as typeof fetch;
    return urls;
  };

  test('keeps polling through in-progress states until done', async () => {
    const urls = statuses('initiated', 'in-progress', 'processing', 'done');
    const sleeps: number[] = [];
    const result = await pollAndScore({
      apiKey: 'k',
      conversationId: 'conv_1',
      keyword: 'otter',
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(result?.won).toBe(true);
    expect(urls).toHaveLength(4);
    expect(sleeps).toEqual([5000, 5000, 5000]);
  });

  test('a failed conversation is scored too', async () => {
    statuses('failed');
    const result = await pollAndScore({
      apiKey: 'k',
      conversationId: 'c',
      keyword: 'otter',
      sleep: async () => {},
    });
    expect(result?.won).toBe(true);
  });

  test('gives up at the poll limit', async () => {
    const urls = statuses('in-progress');
    const result = await pollAndScore({
      apiKey: 'k',
      conversationId: 'c',
      keyword: 'otter',
      sleep: async () => {},
    });
    expect(result).toBeNull();
    expect(urls).toHaveLength(POLL_LIMIT);
  });
});

describe('MissionStore', () => {
  test('keeps the newest MAX_RESULTS', () => {
    const store = new MissionStore();
    for (let i = 0; i < MAX_RESULTS + 3; i++) store.set(`c${i}`, 'pending');
    expect(store.get('c0')).toBeUndefined();
    expect(store.get('c2')).toBeUndefined();
    expect(store.get('c3')).toBe('pending');
    expect(store.get(`c${MAX_RESULTS + 2}`)).toBe('pending');
  });
});
