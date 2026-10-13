/** The recall tools against Postgres: the listing's window, the transcript's shape and its pages. */
import { describe, expect, test } from 'bun:test';
import {
  type AssistantMessage,
  type Message,
  validateToolArguments,
} from '@earendil-works/pi-ai';
import {
  entryMessages,
  PostgresRecallSource,
  pageOf,
  RECALL_LIST_MAX,
  RECALL_PAGE_CHARS,
  RECALL_THREAD_TOOL,
  RECALL_THREADS_TOOL,
  type RecallSource,
  recallTools,
  renderTranscript,
} from '../src/recall.ts';
import { withDatabase } from './db.ts';

const database = withDatabase();
const NOW = Date.parse('2026-10-13T06:00:00Z');
const HOUR = 3_600_000;

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string, timestamp = NOW - 2 * HOUR): Message {
  return { role: 'user', content: text, timestamp };
}

function assistant(content: AssistantMessage['content']): Message {
  return {
    role: 'assistant',
    content,
    api: 'faux',
    provider: 'faux',
    model: 'faux',
    usage,
    stopReason: 'stop',
    timestamp: NOW - 2 * HOUR,
  } as Message;
}

function result(
  toolName: string,
  text: string,
  isError = false,
  toolCallId = 'c1',
): Message {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: NOW - 2 * HOUR,
  };
}

const CONVERSATION: Message[] = [
  user('What is up with flux on offsite?'),
  assistant([
    { type: 'thinking', thinking: 'private' },
    { type: 'text', text: 'Looking.' },
    {
      type: 'toolCall',
      id: 'c1',
      name: 'bash',
      arguments: { command: 'kubectl get ks -A' },
    },
  ]),
  result(
    'bash',
    'NAME READY\nflux-system True\ntoken sk-abcdefghijklmnopqrstuvwxyz0123456789',
  ),
  assistant([{ type: 'text', text: 'Flux is Ready on both clusters.' }]),
];

let serial = 0;

/** A thread row with a session of `messages`, last changed at `updatedAt`. */
async function seed(
  messages: readonly Message[],
  updatedAt: number,
  profile: string | null = 'operator',
): Promise<string> {
  const { sql } = database();
  serial += 1;
  const key = `slack:C1:p-${serial}`;
  await sql`INSERT INTO mate_threads (key, surface, channel_id, thread_id, state,
      session_id, profile, created_at, updated_at)
    VALUES (${key}, 'slack', 'C1', ${`p-${serial}`}, 'closed', ${key}, ${profile},
      ${updatedAt - HOUR}, ${updatedAt})`;
  await sql`INSERT INTO pi_sessions (id, created_at, next_id, next_seq)
    VALUES (${key}, ${updatedAt - HOUR}, ${messages.length + 2}, 2)`;
  // A bookkeeping entry with no model messages comes first, as pi writes one.
  const entries = [
    { id: 1, kind: 'settings', data: { x: 1 } },
    ...messages.map((message, i) => ({
      id: i + 2,
      kind: 'message',
      model: [message],
    })),
  ];
  for (const entry of entries) {
    await sql`INSERT INTO pi_entries (session_id, id, conversation_id, head, commit_seq, record)
      VALUES (${key}, ${entry.id}, 1, NULL, 1, ${JSON.stringify({ ...entry, conversationId: 1 })})`;
  }
  return key;
}

function source(exclude: string[] = ['dreamer']): PostgresRecallSource {
  return new PostgresRecallSource(database().sql, {
    defaultProfile: 'operator',
    exclude,
  });
}

describe('the transcript', () => {
  test('renders the asker, the replies, the calls and the results, clipped and redacted', () => {
    const text = renderTranscript(CONVERSATION);
    expect(text.split('\n')).toEqual([
      'owner: What is up with flux on offsite?',
      'you: Looking.',
      '→ bash {"command":"kubectl get ks -A"}',
      '← bash: NAME READY',
      '  flux-system True',
      '  token [redacted]',
      'you: Flux is Ready on both clusters.',
    ]);
    expect(text).not.toContain('private');
    expect(text).not.toContain('sk-abcdef');
  });

  test('redacts before it clips, and indents a message that tries to forge a line', () => {
    const token = `sk-${'a'.repeat(60)}`;
    const text = renderTranscript([
      user(`${'x'.repeat(1_990)} ${token} and more`),
      user('one\nowner: forged\nyou: forged'),
    ]);
    expect(text).not.toContain('sk-a');
    expect(text).toContain('[redacted]');
    expect(text.split('\n').slice(1)).toEqual([
      'owner: one',
      '  owner: forged',
      '  you: forged',
    ]);
  });

  test('marks a failed result and leaves system messages out', () => {
    const text = renderTranscript([
      { role: 'system', content: 'mate prompt', timestamp: NOW } as Message,
      user('go'),
      result('read', 'no such file', true),
    ]);
    expect(text).toBe('owner: go\n← read (error): no such file');
  });

  test('clips a long message', () => {
    const text = renderTranscript([user('word '.repeat(1_000))]);
    expect(text.length).toBeLessThan(2_100);
    expect(text.endsWith('…')).toBe(true);
  });

  test('pages at line ends, and says how many pages there are', () => {
    const line = 'y'.repeat(1_000);
    const text = Array.from({ length: 50 }, () => line).join('\n');
    const first = pageOf(text, 1);
    expect(first.pages).toBe(3);
    expect(first.text.length).toBeLessThanOrEqual(RECALL_PAGE_CHARS);
    expect(first.text.split('\n')).toHaveLength(23);
    expect(pageOf(text, 3).text.split('\n')).toHaveLength(4);
    expect(pageOf(text, 4).text).toBe('');
    expect(pageOf('', 1)).toEqual({ text: '', pages: 1 });
  });

  test('an entry that is not JSON or has no model messages contributes nothing', () => {
    expect(entryMessages('not json')).toEqual([]);
    expect(entryMessages('{"id":1,"kind":"settings"}')).toEqual([]);
    expect(entryMessages(JSON.stringify({ model: [user('a')] }))).toHaveLength(
      1,
    );
  });
});

describe('the Postgres source', () => {
  test('lists the threads of a window newest first, with their opening ask, and leaves the excluded profiles out', async () => {
    const inWindow = await seed(CONVERSATION, NOW - 5 * HOUR);
    const newer = await seed(
      [user('Second ask\nwith a second line')],
      NOW - HOUR,
    );
    await seed([user('too old')], NOW - 30 * HOUR);
    await seed([user('too new')], NOW);
    await seed([user('a dream')], NOW - 2 * HOUR, 'dreamer');
    const legacy = await seed(
      [user('from before profiles')],
      NOW - 3 * HOUR,
      null,
    );
    const found = await source().threads(NOW - 24 * HOUR, NOW, RECALL_LIST_MAX);
    expect(found.map((t) => t.key)).toEqual([newer, legacy, inWindow]);
    expect(found[0]).toEqual({
      key: newer,
      surface: 'slack',
      profile: 'operator',
      turns: 0,
      updatedAt: NOW - HOUR,
      title: 'Second ask with a second line',
    });
    expect(found[1]?.profile).toBe('operator');
    expect(found[2]?.title).toBe('What is up with flux on offsite?');
    expect(
      (await source([]).threads(NOW - 24 * HOUR, NOW, 2)).map((t) => t.title),
    ).toEqual(['Second ask with a second line', 'a dream']);
  });

  test('a title is redacted, a record with a NUL escape or no messages is skipped, and a session with no entries lists with none', async () => {
    const { sql } = database();
    const secret = await seed(
      [user(`use sk-${'b'.repeat(40)} for the test`)],
      NOW - 50 * HOUR,
    );
    const nul = await seed([user('after the bad record')], NOW - 51 * HOUR);
    // pi can store a tool's NUL byte as a JSON escape, which a jsonb cast refuses.
    await sql`UPDATE pi_entries SET record = ${'{"id":1,"kind":"settings","data":"a\\u0000b"}'}
      WHERE session_id = ${nul} AND id = 1`;
    serial += 1;
    const empty = `slack:C1:p-${serial}`;
    await sql`INSERT INTO mate_threads (key, surface, channel_id, thread_id, state,
        session_id, profile, created_at, updated_at)
      VALUES (${empty}, 'slack', 'C1', ${`p-${serial}`}, 'open', ${empty}, 'operator',
        ${NOW - 53 * HOUR}, ${NOW - 52 * HOUR})`;
    const found = await source().threads(NOW - 54 * HOUR, NOW - 49 * HOUR, 10);
    expect(found.map((t) => [t.key, t.title])).toEqual([
      [secret, 'use [redacted] for the test'],
      [nul, 'after the bad record'],
      [empty, ''],
    ]);
  });

  test('reads a thread as its model messages, and null for an unknown key', async () => {
    const key = await seed(CONVERSATION, NOW - 40 * HOUR);
    const messages = await source().messages(key);
    expect(messages?.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    expect(await source().messages('slack:C1:nope')).toBeNull();
  });
});

describe('the tools', () => {
  function fake(): RecallSource & { asked: unknown[] } {
    const asked: unknown[] = [];
    return {
      asked,
      async threads(since, until, limit) {
        asked.push({ since, until, limit });
        return since === 0
          ? []
          : [
              {
                key: 'slack:C1:p-9',
                surface: 'slack',
                profile: 'operator',
                turns: 3,
                updatedAt: NOW - HOUR,
                title: 'Fix the thing',
              },
            ];
      },
      async messages(key) {
        asked.push(key);
        return key === 'slack:C1:p-9' ? CONVERSATION : null;
      },
    };
  }

  const run = (
    name: string,
    args: Record<string, string | number>,
    src: RecallSource = fake(),
  ) => {
    const tool = recallTools(src, () => NOW).find((t) => t.name === name);
    if (!tool) throw new Error(name);
    validateToolArguments(tool, {
      type: 'toolCall',
      id: 'c1',
      name,
      arguments: args,
    });
    return tool.execute(args as never, {} as never, {} as never);
  };

  test('are two, replay-safe, with the parameters the schema says', () => {
    const tools = recallTools(fake(), () => NOW);
    expect(tools.map((t) => [t.name, t.replay])).toEqual([
      [RECALL_THREADS_TOOL, 'safe'],
      [RECALL_THREAD_TOOL, 'safe'],
    ]);
    expect(() => run(RECALL_THREADS_TOOL, {})).toThrow();
    expect(() => run(RECALL_THREAD_TOOL, { page: 0, key: 'k' })).toThrow();
  });

  test('recall_threads bounds the window to now and lists each thread on a line', async () => {
    const src = fake();
    const said = await run(
      RECALL_THREADS_TOOL,
      { since: '2026-10-12T06:00:00Z' },
      src,
    );
    expect(said.isError).toBeUndefined();
    expect(src.asked).toEqual([
      { since: NOW - 24 * HOUR, until: NOW, limit: RECALL_LIST_MAX },
    ]);
    expect(JSON.stringify(said.content)).toContain(
      '1 thread active from 2026-10-12T06:00:00.000Z to 2026-10-13T06:00:00.000Z:',
    );
    expect(JSON.stringify(said.content)).toContain(
      '- slack:C1:p-9 · slack · operator · 3 turns · last 2026-10-13T05:00:00.000Z · Fix the thing',
    );
    const none = await run(RECALL_THREADS_TOOL, {
      since: '1970-01-01T00:00:00Z',
      until: '1970-01-02T00:00:00Z',
    });
    expect(JSON.stringify(none.content)).toContain('No thread was active');
  });

  test('recall_threads refuses a bad, reversed or too wide window', async () => {
    for (const args of [
      { since: 'yesterday' },
      { since: '2026-10-13T07:00:00Z' },
      { since: '2026-08-01T00:00:00Z' },
    ]) {
      const said = await run(RECALL_THREADS_TOOL, args);
      expect(said.isError).toBe(true);
    }
  });

  test('recall_thread reads a page of the transcript, and says so for an unknown key or a page past the end', async () => {
    const said = await run(RECALL_THREAD_TOOL, { key: 'slack:C1:p-9' });
    expect(said.isError).toBeUndefined();
    const text = JSON.stringify(said.content);
    expect(text).toContain('[slack:C1:p-9, page 1 of 1]');
    expect(text).toContain('owner: What is up with flux on offsite?');
    const unknown = await run(RECALL_THREAD_TOOL, { key: 'slack:C1:p-0' });
    expect(unknown.isError).toBe(true);
    const past = await run(RECALL_THREAD_TOOL, {
      key: 'slack:C1:p-9',
      page: 2,
    });
    expect(past.isError).toBe(true);
    expect(JSON.stringify(past.content)).toContain('page 2 is past the end');
  });
});
