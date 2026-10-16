import { describe, expect, test } from 'bun:test';
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { modelVoiceLane, VOICE_PROMPT } from '../src/voice-lane.ts';
import { RecordingLog } from './support.ts';

const MODEL = {
  id: 'qwen3.8-flash',
  provider: 'opencode-go',
  api: 'openai-completions',
  contextWindow: 100_000,
} as unknown as Model<Api>;

function fakeModels(play: 'words' | 'error' | 'tool') {
  const calls: { context: TranscriptContext; options?: SimpleStreamOptions }[] =
    [];
  const models = {
    streamSimple(
      _model: Model<Api>,
      context: TranscriptContext,
      options?: SimpleStreamOptions,
    ) {
      calls.push({ context, options });
      const out = createAssistantMessageEventStream();
      const partial = {
        role: 'assistant',
        content: [],
        api: MODEL.api,
        provider: MODEL.provider,
        model: MODEL.id,
        stopReason: 'stop',
        timestamp: 1,
      } as unknown as AssistantMessage;
      queueMicrotask(() => {
        if (play === 'tool' && calls.length === 1) {
          const call = {
            type: 'toolCall' as const,
            id: 'c1',
            name: 'task_status',
            arguments: {},
          };
          out.push({
            type: 'text_delta',
            contentIndex: 0,
            delta: 'Let me look. ',
            partial,
          });
          out.push({
            type: 'toolcall_end',
            contentIndex: 1,
            toolCall: call,
            partial,
          });
          out.end({ ...partial, content: [call], stopReason: 'toolUse' });
          return;
        }
        if (play === 'error') {
          out.push({
            type: 'error',
            reason: 'error',
            error: { ...partial, stopReason: 'error', errorMessage: 'boom' },
          });
          out.end({ ...partial, stopReason: 'error', errorMessage: 'boom' });
          return;
        }
        out.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: 'all ',
          partial,
        });
        out.push({
          type: 'text_delta',
          contentIndex: 0,
          delta: 'good',
          partial,
        });
        out.end(partial);
      });
      return out;
    },
  };
  return { models, calls };
}

const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const s of it) out.push(s);
  return out;
};

describe('the model voice lane', () => {
  test('sends the transcript as the context, with the spoken prompt, and yields the text deltas', async () => {
    const { models, calls } = fakeModels('words');
    const lane = modelVoiceLane({
      models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 1234,
      log: new RecordingLog(),
    });
    const signal = new AbortController().signal;
    const words = await collect(
      lane.reply(
        [
          { role: 'user', content: 'hello' },
          { role: 'agent', content: 'hi' },
          { role: 'user', content: 'all good?' },
        ],
        signal,
        'conv_1',
      ),
    );
    expect(words).toEqual(['all ', 'good']);
    const call = calls[0];
    expect(call?.options).toMatchObject({
      signal,
      timeoutMs: 1234,
      sessionId: 'conv_1',
    });
    expect(call?.options && 'reasoning' in call.options).toBe(false);
    const messages = call?.context.messages ?? [];
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: VOICE_PROMPT,
    });
    expect(messages.slice(1).map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(messages[2]).toMatchObject({
      content: [{ type: 'text', text: 'hi' }],
      model: MODEL.id,
    });
  });

  test('asks for the thinking level unless it is off, and throws on a model error', async () => {
    const { models, calls } = fakeModels('error');
    const lane = modelVoiceLane({
      models,
      model: MODEL,
      thinking: 'low',
      timeoutMs: 1000,
      log: new RecordingLog(),
    });
    await expect(
      collect(
        lane.reply(
          [{ role: 'user', content: 'x' }],
          new AbortController().signal,
          'conv_2',
        ),
      ),
    ).rejects.toThrow('boom');
    expect(calls[0]?.options).toMatchObject({ reasoning: 'low' });
  });

  test('runs a tool round in mate and speaks what the model says before and after', async () => {
    const { models, calls } = fakeModels('tool');
    const ran: unknown[] = [];
    const lane = modelVoiceLane({
      models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      log: new RecordingLog(),
    });
    const words = await collect(
      lane.reply(
        [{ role: 'user', content: 'how is the task' }],
        new AbortController().signal,
        'conv_3',
        [
          {
            name: 'task_status',
            description: 'status',
            parameters: { type: 'object', properties: {} } as never,
            sideEffect: false,
            execute: async (args) => {
              ran.push(args);
              return 'still running';
            },
          },
        ],
      ),
    );
    expect(words).toEqual(['Let me look. ', 'all ', 'good']);
    expect(ran).toEqual([{}]);
    expect(calls).toHaveLength(2);
    const system = calls[0]?.context.messages[0] as
      | { toolsAdded?: { name: string }[] }
      | undefined;
    expect(system?.toolsAdded?.map((t) => t.name)).toEqual(['task_status']);
    const second = calls[1]?.context.messages ?? [];
    expect(second.at(-2)?.role).toBe('assistant');
    expect(second.at(-1)).toMatchObject({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'task_status',
      isError: false,
    });
  });
});
