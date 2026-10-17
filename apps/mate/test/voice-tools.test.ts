import { describe, expect, test } from 'bun:test';
import type { Message } from '@earendil-works/pi-ai';
import type { RecallSource } from '../src/recall.ts';
import type { ThreadState } from '../src/threads.ts';
import {
  lastSaid,
  START_TASK_TOOL,
  TASK_STATUS_TOOL,
  type VoiceToolContext,
  voiceTools,
} from '../src/voice-tools.ts';

function harness(options: { recall?: RecallSource | null } = {}) {
  const started: string[] = [];
  const states = new Map<string, ThreadState>();
  let heard = '';
  const context: VoiceToolContext = {
    lastHeard: () => heard,
    started: [],
  };
  const tools = voiceTools(
    {
      startTask: async (task) => {
        started.push(task);
        const key = `k${started.length}`;
        states.set(key, 'turn');
        return key;
      },
      threadState: (key) => states.get(key),
      recall: options.recall ?? null,
      now: () => 1_000,
      people: async () => '- the owner',
    },
    context,
  );
  const tool = (name: string) => {
    const found = tools.find((one) => one.name === name);
    if (!found) throw new Error(`no ${name}`);
    return found;
  };
  return {
    tools,
    tool,
    started,
    states,
    context,
    say: (words: string) => {
      heard = words;
    },
  };
}

describe('the voice tools', () => {
  test('start_task records the task first, then starts it once the owner said yes', async () => {
    const h = harness();
    const start = h.tool(START_TASK_TOOL);
    expect(start.sideEffect).toBe(true);
    const first = await start.execute({ task: 'rotate the mate token' });
    expect(first).toContain('Not started yet');
    expect(first).toContain('rotate the mate token');
    expect(h.started).toEqual([]);
    h.say('no, leave it');
    expect(await start.execute({ task: 'rotate the mate token' })).toContain(
      'Not started yet',
    );
    h.say('yes please');
    const second = await start.execute({ task: 'rotate the token' });
    expect(second).toContain('Started');
    // The task read back is the one that runs, not the second call's wording.
    expect(h.started).toEqual(['rotate the mate token']);
    expect(h.context.started.map((t) => t.key)).toEqual(['k1']);
    // The next start needs its own read-back.
    expect(await start.execute({ task: 'another' })).toContain(
      'Not started yet',
    );
  });

  test('a read-only task starts at once, with no read-back', async () => {
    const h = harness();
    const start = h.tool(START_TASK_TOOL);
    expect(
      await start.execute({
        task: 'see whether the backups ran',
        readOnly: true,
      }),
    ).toContain('Started');
    expect(h.started).toEqual(['see whether the backups ran']);
    // A task that changes something still waits for the yes.
    expect(
      await start.execute({ task: 'rotate the key', readOnly: false }),
    ).toContain('Not started yet');
  });

  test('start_task reports a thread that could not start', async () => {
    const context: VoiceToolContext = {
      lastHeard: () => 'yes',
      started: [],
    };
    const [start] = voiceTools(
      {
        startTask: async () => {
          throw new Error('the call has no text channel');
        },
        threadState: () => undefined,
        recall: null,
        now: () => 0,
        people: async () => '- the owner',
      },
      context,
    );
    if (!start) throw new Error('no tool');
    await start.execute({ task: 'x' });
    expect(await start.execute({ task: 'x' })).toContain(
      'could not be started',
    );
    expect(context.started).toEqual([]);
  });

  test('task_status names each task and whether it still runs', async () => {
    const h = harness();
    const status = h.tool(TASK_STATUS_TOOL);
    expect(status.sideEffect).toBe(false);
    expect(await status.execute({})).toContain('No work');
    const start = h.tool(START_TASK_TOOL);
    await start.execute({ task: 'check the backups' });
    h.say('yes');
    await start.execute({ task: 'check the backups' });
    expect(await status.execute({})).toBe(
      '- "check the backups": still running',
    );
    h.states.set('k1', 'idle');
    expect(await status.execute({})).toBe('- "check the backups": finished');
  });

  test('recall tools come along when mate has a store, answering in text', async () => {
    const recall: RecallSource = {
      threads: async () => [
        {
          key: 'discord:1',
          surface: 'discord',
          profile: 'operator',
          turns: 2,
          updatedAt: 500,
          title: 'fix the fence',
        },
      ],
      messages: async () => null,
    };
    const h = harness({ recall });
    expect(h.tools.map((t) => t.name)).toEqual([
      START_TASK_TOOL,
      TASK_STATUS_TOOL,
      'channel_members',
      'recall_threads',
      'recall_thread',
    ]);
    const list = await h.tool('recall_threads').execute({
      since: '1970-01-01T00:00:00Z',
    });
    expect(list).toContain('fix the fence');
    expect(h.tool('recall_threads').sideEffect).toBe(false);
  });

  test('lastSaid is the last assistant text of a thread', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'do it', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done: the fence is up.' }],
        api: 'openai-completions',
        provider: 'opencode-go',
        model: 'm',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: 2,
      } as unknown as Message,
    ];
    const recall: RecallSource = {
      threads: async () => [],
      messages: async (key) => (key === 'k' ? messages : null),
    };
    expect(await lastSaid(recall, 'k')).toBe('Done: the fence is up.');
    expect(await lastSaid(recall, 'other')).toBeNull();
  });
});
