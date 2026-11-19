import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  ConversationView,
  EntryRecord,
  LiveState,
} from '@earendil-works/pi-durable';
import { turnEvents } from '../src/brain.ts';

function view(
  entries: readonly EntryRecord[],
  live: LiveState = {},
): ConversationView {
  return {
    conversation: { id: 1 } as ConversationView['conversation'],
    entries,
    docs: { 'pi.live': live },
  };
}

const answer = {
  role: 'assistant',
  timestamp: 42,
  content: [{ type: 'text', text: 'hello' }],
  stopReason: 'stop',
  usage: { cost: { total: 0 } },
} as unknown as AssistantMessage;

const entry = (id: number, message: unknown) =>
  ({
    id,
    conversationId: 1,
    kind: 'test',
    model: [message],
  }) as unknown as EntryRecord;

describe('conversation view changes', () => {
  test('streams a partial and does not lose the committed answer when progress is folded', () => {
    const first = view([]);
    const partial = view([], {
      generation: {
        attempt: 1,
        message: answer,
      } as unknown as LiveState['generation'],
    });
    const final = view([entry(2, answer)]);
    expect(turnEvents(first, partial).map((event) => event.type)).toEqual([
      'message_start',
    ]);
    expect(turnEvents(partial, final).map((event) => event.type)).toEqual([
      'message_end',
    ]);
    expect(turnEvents(first, final).map((event) => event.type)).toEqual([
      'message_end',
    ]);
  });

  test('ends the previous answer before showing the next partial after a folded update', () => {
    const before = view([], {
      run: { taskId: 1, inputs: [], turns: 0 } as unknown as LiveState['run'],
      generation: {
        attempt: 1,
        message: answer,
      } as unknown as LiveState['generation'],
    });
    const after = view([entry(2, answer)], {
      run: { taskId: 2, inputs: [], turns: 1 } as unknown as LiveState['run'],
      generation: {
        attempt: 1,
        message: { ...answer, content: [{ type: 'text', text: 'next' }] },
      } as unknown as LiveState['generation'],
    });
    expect(turnEvents(before, after).map((event) => event.type)).toEqual([
      'message_end',
      'message_start',
    ]);
  });

  test('reports nested tool status from its slot when it has no result entry', () => {
    const finished = view([], {
      nestedTools: [
        {
          callId: 'parent/child',
          name: 'read',
          status: 'done',
          arguments: { path: 'file' },
          summary: { isError: false },
        },
      ] as unknown as LiveState['nestedTools'],
    });
    expect(turnEvents(view([]), finished)).toMatchObject([
      { type: 'tool_execution_start', toolCallId: 'parent/child' },
      { type: 'tool_execution_end', result: { isError: false } },
    ]);
  });

  test('reports a tool result even if the running slot disappears in the same commit', () => {
    const calling = entry(2, {
      ...answer,
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'read',
          arguments: { path: 'file' },
        },
      ],
    });
    const running = view([calling], {
      tools: [{ callId: 'call-1', name: 'read', status: 'running' }],
    });
    const finished = view([
      calling,
      entry(3, { role: 'toolResult', toolCallId: 'call-1', isError: false }),
    ]);
    expect(turnEvents(running, finished).map((event) => event.type)).toEqual([
      'tool_execution_end',
    ]);
  });
});
