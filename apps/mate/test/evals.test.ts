/** The evals: the ledger, the derived context, the decisions, the replay against a faux model, and the read from Postgres. */
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssistantMessage,
  createModels,
  type Message,
  type SimpleStreamOptions,
  type ToolCall,
} from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  action,
  allMessages,
  commandWord,
  contextAt,
  decisions,
  ledger,
  median,
  orderToolResults,
  type RecordedEntry,
  type RecordedThread,
  readThreads,
  recordedEntry,
  renderDisagreements,
  renderLedger,
  renderSummaries,
  replay,
  sample,
  summarize,
} from '../src/evals.ts';
import { count, FileCredentialStore, instant } from '../src/evals-cli.ts';
import { withDatabase } from './db.ts';

const database = withDatabase();
const T0 = Date.parse('2026-10-13T12:00:00Z');
const usage = (total: number) => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

function system(timestamp = T0): Message {
  return {
    role: 'system',
    content: 'You are Testbutt.',
    toolsAdded: [
      {
        name: 'bash',
        description: 'Run a command.',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        } as never,
      },
    ],
    timestamp,
  };
}

function user(text: string, timestamp: number): Message {
  return { role: 'user', content: text, timestamp };
}

function step(
  content: AssistantMessage['content'],
  timestamp: number,
  own: Partial<AssistantMessage> = {},
): Message {
  return {
    role: 'assistant',
    content,
    api: 'faux',
    provider: 'openai-codex',
    model: 'gpt-6-sol',
    usage: usage(0.01),
    stopReason: 'stop',
    timestamp,
    ...own,
  } as Message;
}

const call = (
  name: string,
  args: Record<string, string>,
  id = 'c1',
): ToolCall => ({ type: 'toolCall', id, name, arguments: args }) as ToolCall;

function result(
  id: string,
  text: string,
  isError: boolean,
  timestamp: number,
): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError,
    timestamp,
  };
}

/** One entry per message, ids from 1, as pi writes a plain thread. */
function entries(
  messages: readonly Message[],
  own: Record<number, Partial<RecordedEntry>> = {},
): RecordedEntry[] {
  return messages.map((message, i) => ({
    id: i + 1,
    head: null,
    edits: [],
    messages: [message],
    ...own[i + 1],
  }));
}

/** A thread of two steps: a bash call whose result failed, then an answer. */
function thread(key = 'slack:C1:p-1', profile = 'operator'): RecordedThread {
  return {
    key,
    profile,
    updatedAt: T0 + 60_000,
    entries: entries([
      system(),
      user('is flux ok?', T0 + 1_000),
      step([call('bash', { command: 'kubectl get ks -A' })], T0 + 3_000, {
        stopReason: 'toolUse',
      }),
      result('c1', 'error: timeout', true, T0 + 9_000),
      step([{ type: 'text', text: 'It timed out.' }], T0 + 11_000),
    ]),
  };
}

describe('the ledger', () => {
  test('counts each model’s steps, calls, failed tools, errors and cost, with the latency from the message before', () => {
    const slow: RecordedThread = {
      key: 'slack:C1:p-2',
      profile: 'custodian',
      updatedAt: T0,
      entries: entries([
        system(),
        user('check', T0),
        step([{ type: 'text', text: '' }], T0 + 30_000, {
          provider: 'opencode-go',
          model: 'qwen3.8-max',
          stopReason: 'error',
          usage: usage(0.5),
        }),
      ]),
    };
    const rows = ledger([thread(), slow]);
    expect(rows).toEqual([
      {
        model: 'openai-codex/gpt-6-sol',
        steps: 2,
        toolCalls: 1,
        toolErrors: 1,
        errors: 0,
        aborted: 0,
        cost: 0.02,
        latencies: [2_000, 2_000],
      },
      {
        model: 'opencode-go/qwen3.8-max',
        steps: 1,
        toolCalls: 0,
        toolErrors: 0,
        errors: 1,
        aborted: 0,
        cost: 0.5,
        latencies: [30_000],
      },
    ]);
    expect(renderLedger(rows)).toMatch(
      /openai-codex\/gpt-6-sol\s+2\s+1\s+1\s+0\s+0\s+2\.0s\s+\$0\.02/,
    );
    expect(renderLedger([])).toBe('No recorded steps in the window.');
  });

  test('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  test('a record that is not JSON, or has no model, contributes nothing; a head marker and edits are kept', () => {
    expect(recordedEntry(3, 'nope')).toEqual({
      id: 3,
      head: null,
      edits: [],
      messages: [],
    });
    const marker = recordedEntry(
      9,
      JSON.stringify({
        id: 9,
        kind: 'compaction',
        head: 4,
        edits: [{ target: 2, action: 'omit' }],
        model: [user('summary', T0)],
      }),
    );
    expect(marker).toMatchObject({ id: 9, head: 4 });
    expect(marker.edits).toEqual([{ target: 2, action: 'omit' }]);
    expect(marker.messages).toHaveLength(1);
  });
});

describe('the derived context', () => {
  test('starts at the newest head marker, which leads, drops omitted and aborted entries, replaces, and orders results after their step', () => {
    const list = entries(
      [
        system(), // 1
        user('first', T0), // 2
        step([call('bash', { command: 'ls' }, 'a')], T0 + 1, {
          stopReason: 'toolUse',
        }), // 3
        result('a', 'files', false, T0 + 2), // 4
        step([{ type: 'text', text: 'done' }], T0 + 3), // 5
        user('summary of 1-5', T0 + 4), // 6: the compaction's marker
        { ...system(T0 + 5), content: 'baseline' } as Message, // 7: the baseline the marker brings
        user('second', T0 + 6), // 8
        step([{ type: 'text', text: 'oops' }], T0 + 7, {
          stopReason: 'aborted',
        }), // 9
        step(
          [
            call('bash', { command: 'pwd' }, 'b'),
            call('bash', { command: 'id' }, 'c'),
          ],
          T0 + 8,
          { stopReason: 'toolUse' },
        ), // 10
        result('c', 'uid', false, T0 + 9), // 11: out of call order, and b is missing
        step([{ type: 'text', text: 'end' }], T0 + 10), // 12
      ],
      {
        6: { head: 5, edits: [{ target: 5, action: 'omit' }] },
        7: {
          edits: [
            {
              target: 8,
              action: 'replace',
              messages: [user('second, replaced', T0 + 6)],
            },
          ],
        },
      },
    );
    // Before the marker: the plain transcript.
    expect(contextAt(list, 3).map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'toolResult',
    ]);
    expect(contextAt(list, -1)).toEqual([]);
    // At the tail: the marker leads, entry 5 is omitted, 8 replaced, 9 left out,
    // and the step's two results follow it in call order with b synthesized.
    const context = contextAt(list, 10);
    expect(
      context.map((m) =>
        m.role === 'user'
          ? `user:${typeof m.content === 'string' ? m.content : '?'}`
          : m.role,
      ),
    ).toEqual([
      'user:summary of 1-5',
      'system',
      'user:second, replaced',
      'assistant',
      'toolResult',
      'toolResult',
    ]);
    const results = context.filter((m) => m.role === 'toolResult');
    expect(
      results.map((m) => (m.role === 'toolResult' ? m.toolCallId : '')),
    ).toEqual(['b', 'c']);
    expect(JSON.stringify(results[0])).toContain(
      'history ends before this call completed',
    );
    // The step at entry 12 sees the same, and the ledger still sees everything.
    expect(
      allMessages({ key: 'k', profile: 'p', updatedAt: 0, entries: list }),
    ).toHaveLength(12);
  });

  test('unmatched results are dropped and a step with no call keeps none', () => {
    const ordered = orderToolResults([
      user('a', T0),
      result('zzz', 'stray', false, T0),
      step([{ type: 'text', text: 'hi' }], T0),
      result('yyy', 'stray', false, T0),
    ]);
    expect(ordered.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('decisions', () => {
  test('are the steps that called a tool, each with the context pi sent, and none without a system message', () => {
    const [only, ...rest] = decisions(thread());
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      thread: 'slack:C1:p-1',
      profile: 'operator',
      entry: 3,
      by: 'openai-codex/gpt-6-sol',
      recorded: { name: 'bash' },
    });
    expect(only?.context.map((m) => m.role)).toEqual(['system', 'user']);
    const headless = thread();
    expect(
      decisions({ ...headless, entries: headless.entries.slice(1) }),
    ).toEqual([]);
  });

  test('a step that was aborted or errored is no decision, and a parallel step is scored by its first call', () => {
    const list = entries([
      system(),
      user('go', T0),
      step([call('bash', { command: 'ls' }, 'a')], T0 + 1, {
        stopReason: 'aborted',
      }),
      step(
        [
          call('read', { path: '/workspace/a' }, 'b'),
          call('bash', { command: 'ls' }, 'c'),
        ],
        T0 + 2,
        { stopReason: 'toolUse' },
      ),
    ]);
    const found = decisions({
      key: 'k',
      profile: 'operator',
      updatedAt: 0,
      entries: list,
    });
    expect(found.map((d) => [d.entry, d.recorded.name])).toEqual([[4, 'read']]);
  });

  test('the sample takes the newest of each thread in turn, up to the limit', () => {
    const long: RecordedThread = {
      ...thread('slack:C1:p-9'),
      entries: entries([
        system(),
        user('a', T0),
        step([call('bash', { command: 'ls' }, 'a')], T0 + 1, {
          stopReason: 'toolUse',
        }),
        result('a', '', false, T0 + 2),
        step([call('bash', { command: 'pwd' }, 'b')], T0 + 3, {
          stopReason: 'toolUse',
        }),
        result('b', '', false, T0 + 4),
        step([call('read', { path: '/workspace/AGENTS.md' }, 'c')], T0 + 5, {
          stopReason: 'toolUse',
        }),
      ]),
    };
    const picked = sample([long, thread()], 3);
    expect(picked.map((d) => `${d.thread}#${d.entry}`)).toEqual([
      'slack:C1:p-9#7',
      'slack:C1:p-1#3',
      'slack:C1:p-9#5',
    ]);
    expect(sample([long], 10)).toHaveLength(3);
  });

  test('an action is the tool with the word of its command or its path', () => {
    expect(commandWord('  kubectl get ks -A')).toBe('kubectl');
    expect(commandWord('cd /workspace && cd apps && bun test')).toBe('bun');
    expect(commandWord('FOO=1 sudo env BAR=2 -i systemctl status')).toBe(
      'systemctl',
    );
    expect(commandWord('')).toBe('');
    expect(action(call('bash', { command: 'kubectl get ks -A' }))).toBe(
      'bash kubectl',
    );
    expect(action(call('bash', { command: '' }))).toBe('bash');
    expect(action(call('read', { path: '/workspace/AGENTS.md' }))).toBe(
      'read AGENTS.md',
    );
    expect(action(call('edit', { path: '/etc/hosts' }))).toBe(
      'edit /etc/hosts',
    );
    expect(action(call('write', {}))).toBe('write');
    expect(action(call('weather_forecast', { place: 'Halifax' }))).toBe(
      'weather_forecast',
    );
  });
});

describe('the replay', () => {
  const price = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

  function candidate() {
    const handle = fauxProvider({
      api: 'faux',
      provider: 'faux',
      models: [{ id: 'faux-a', reasoning: true, cost: price }],
    });
    const models = createModels();
    models.setProvider(handle.provider);
    const model = handle.getModel('faux-a');
    if (!model) throw new Error('no faux model');
    return { handle, models, model };
  }

  test('sends the context and the reasoning level, and scores the same tool, the same action, a text answer and an error', async () => {
    const { handle, models, model } = candidate();
    const list = [
      ...decisions(thread('slack:C1:p-1')),
      ...decisions(thread('slack:C1:p-2')),
      ...decisions(thread('slack:C1:p-3')),
      ...decisions(thread('slack:C1:p-4')),
    ];
    const seen: {
      roles: string[];
      options: SimpleStreamOptions | undefined;
    }[] = [];
    const record =
      (reply: AssistantMessage) =>
      (
        context: { messages: readonly Message[] },
        options: SimpleStreamOptions | undefined,
      ) => {
        seen.push({ roles: context.messages.map((m) => m.role), options });
        return reply;
      };
    handle.setResponses([
      record(
        fauxAssistantMessage(
          fauxToolCall('bash', { command: 'kubectl get kustomizations -A' }),
          { stopReason: 'toolUse' },
        ),
      ),
      record(
        fauxAssistantMessage(
          fauxToolCall('bash', { command: 'flux get ks -A' }),
          {
            stopReason: 'toolUse',
          },
        ),
      ),
      record(fauxAssistantMessage('Flux is fine.')),
      record(
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'over quota',
        }),
      ),
    ]);
    const progress: number[] = [];
    const verdicts = await replay(models, model, list, {
      thinking: 'medium',
      onVerdict: (_v, done) => progress.push(done),
    });
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(seen).toHaveLength(4);
    expect(seen[0]?.roles).toEqual(['system', 'user']);
    expect(seen[0]?.options?.reasoning).toBe('medium');
    expect(
      verdicts.map((v) => [
        v.tool,
        v.action,
        v.proposed?.name ?? null,
        v.error,
      ]),
    ).toEqual([
      [true, true, 'bash', null],
      [true, false, 'bash', null],
      [false, false, null, null],
      [false, false, null, expect.stringContaining('over quota')],
    ]);
    expect(verdicts[0]?.proposed?.arguments).toEqual({
      command: 'kubectl get kustomizations -A',
    });
    const summary = summarize('faux/faux-a', verdicts);
    expect(summary).toMatchObject({
      model: 'faux/faux-a',
      decisions: 4,
      answered: 3,
      sameTool: 2,
      sameAction: 1,
      noTool: 1,
      errors: 1,
    });
    expect(renderSummaries([summary])).toContain(
      'faux/faux-a  4          3         67%        33%',
    );
    expect(renderDisagreements(verdicts)).toBe(
      [
        '- slack:C1:p-2 entry 3: recorded bash kubectl (openai-codex/gpt-6-sol); candidate bash flux',
        '- slack:C1:p-3 entry 3: recorded bash kubectl (openai-codex/gpt-6-sol); candidate no tool',
      ].join('\n'),
    );
    expect(renderSummaries([])).toBe('No decisions to replay in the window.');
  });

  test('thinking off sends no reasoning level', async () => {
    const { handle, models, model } = candidate();
    let options: SimpleStreamOptions | undefined;
    handle.setResponses([
      (_context: unknown, given: SimpleStreamOptions | undefined) => {
        options = given;
        return fauxAssistantMessage('ok');
      },
    ]);
    await replay(models, model, decisions(thread()), { thinking: 'off' });
    expect(options?.reasoning).toBeUndefined();
  });
});

describe('the CLI pieces', () => {
  test('an instant is now, a duration back from now, or ISO 8601', () => {
    expect(instant('now', T0)).toBe(T0);
    expect(instant('7d', T0)).toBe(T0 - 7 * 86_400_000);
    expect(instant('90m', T0)).toBe(T0 - 90 * 60_000);
    expect(instant('2026-10-01T00:00:00Z', T0)).toBe(
      Date.parse('2026-10-01T00:00:00Z'),
    );
    expect(() => instant('yesterday', T0)).toThrow('not a duration');
  });

  test('a count is a whole number of at least 1', () => {
    expect(count('threads', '40')).toBe(40);
    for (const bad of ['0', '-1', 'abc', '1.5', '']) {
      expect(() => count('threads', bad)).toThrow('--threads must be');
    }
  });

  test('the file credential store reads, lists, modifies in place at mode 0600 through a rename, and deletes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mate-evals-'));
    try {
      const path = join(dir, 'auth.json');
      const store = new FileCredentialStore(path);
      expect(await store.read('openai-codex')).toBeUndefined();
      expect(await store.list()).toEqual([]);
      await store.modify('openai-codex', async () => ({
        type: 'oauth',
        access: 'a',
        refresh: 'r',
        expires: 1,
      }));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      // A file left readable by others is tightened at the next write.
      chmodSync(path, 0o644);
      const kept = await store.modify('openai-codex', async (current) =>
        current?.type === 'oauth' ? { ...current, access: 'b' } : undefined,
      );
      expect(kept).toMatchObject({ access: 'b', refresh: 'r' });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(existsSync(`${path}.tmp`)).toBe(false);
      expect(await store.list()).toEqual([
        { providerId: 'openai-codex', type: 'oauth' },
      ]);
      expect(
        await store.modify('openai-codex', async () => undefined),
      ).toMatchObject({
        access: 'b',
      });
      // Writes serialize: two refreshes in flight land both, in order.
      await Promise.all([
        store.modify('openai-codex', async (c) =>
          c?.type === 'oauth' ? { ...c, access: 'c' } : undefined,
        ),
        store.modify('openai-codex', async (c) =>
          c?.type === 'oauth' ? { ...c, access: `${c.access}d` } : undefined,
        ),
      ]);
      expect(
        (await store.read('openai-codex')) as { access?: string },
      ).toMatchObject({
        access: 'cd',
      });
      await store.delete('openai-codex');
      expect(await store.read('openai-codex')).toBeUndefined();
      await store.delete('never-there');
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a delete on a file that does not exist creates none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mate-evals-'));
    try {
      const path = join(dir, 'auth.json');
      await new FileCredentialStore(path).delete('x');
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, '{}');
      expect(await new FileCredentialStore(path).list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Postgres read', () => {
  async function seed(
    key: string,
    profile: string | null,
    updatedAt: number,
    messages: Message[],
    conversation = 1,
  ) {
    const { sql } = database();
    await sql`INSERT INTO mate_threads (key, surface, channel_id, thread_id, state,
        session_id, profile, created_at, updated_at)
      VALUES (${key}, 'slack', 'C1', ${key}, 'closed', ${key}, ${profile}, ${updatedAt - 1}, ${updatedAt})
      ON CONFLICT (key) DO NOTHING`;
    await sql`INSERT INTO pi_sessions (id, created_at, next_id, next_seq)
      VALUES (${key}, ${updatedAt - 1}, ${messages.length + 1}, 2)
      ON CONFLICT (id) DO NOTHING`;
    for (const [i, message] of messages.entries()) {
      const id = conversation * 100 + i + 1;
      await sql`INSERT INTO pi_entries (session_id, id, conversation_id, head, commit_seq, record)
        VALUES (${key}, ${id}, ${conversation}, NULL, 1, ${JSON.stringify({ id, conversationId: conversation, kind: 'x', model: [message] })})`;
    }
  }

  test('reads the window newest first, the root conversation only, with the profile filter and a row from before profiles', async () => {
    const one = allMessages(thread());
    await seed('k-new', 'custodian', T0 + 5_000, one);
    // A side conversation of the same session is not the thread's transcript.
    await seed('k-new', 'custodian', T0 + 5_000, [user('aside', T0)], 2);
    await seed('k-old', null, T0 + 1_000, one.slice(0, 2));
    await seed('k-out', 'operator', T0 + 50_000, []);
    const all = await readThreads(database().sql, {
      since: T0,
      until: T0 + 10_000,
      limit: 10,
    });
    expect(all.map((t) => [t.key, t.profile, t.entries.length])).toEqual([
      ['k-new', 'custodian', 5],
      ['k-old', 'operator', 2],
    ]);
    expect(all[0]?.entries.map((e) => e.id)).toEqual([101, 102, 103, 104, 105]);
    const custodian = await readThreads(database().sql, {
      since: T0,
      until: T0 + 10_000,
      limit: 10,
      profile: 'custodian',
    });
    expect(custodian.map((t) => t.key)).toEqual(['k-new']);
    expect(ledger(all)[0]?.steps).toBe(2);
    expect(decisions(all[0] as RecordedThread)).toHaveLength(1);
  });
});
