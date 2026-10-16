import { describe, expect, test } from 'bun:test';
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import {
  FILLERS,
  modelVoiceLane,
  TOOL_ACK,
  VOICE_PROMPT,
} from '../src/voice-lane.ts';
import { RecordingLog } from './support.ts';

const MODEL = {
  id: 'qwen3.8-flash',
  provider: 'opencode-go',
  api: 'openai-completions',
  contextWindow: 100_000,
} as unknown as Model<Api>;

function fakeModels(
  play: 'words' | 'error' | 'tool' | 'silent-tool',
  delayMs = 0,
) {
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
      const round = calls.length;
      const begin = (fn: () => void) =>
        delayMs > 0 ? setTimeout(fn, delayMs) : queueMicrotask(fn);
      begin(() => {
        if (play === 'silent-tool' && round <= 2) {
          const call = {
            type: 'toolCall' as const,
            id: `c${round}`,
            name: 'task_status',
            arguments: {},
          };
          out.push({ type: 'toolcall_start', contentIndex: 0, partial });
          out.push({
            type: 'toolcall_end',
            contentIndex: 0,
            toolCall: call,
            partial,
          });
          out.end({ ...partial, content: [call], stopReason: 'toolUse' });
          return;
        }
        if (play === 'tool' && round === 1) {
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

const STATUS = {
  name: 'task_status',
  description: 'status',
  parameters: { type: 'object', properties: {} } as never,
  sideEffect: false,
  execute: async () => 'still running',
};

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

  test('opens a slow turn with one flat filler before the first word', async () => {
    const { models } = fakeModels('words', 60);
    const lane = modelVoiceLane({
      models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      fillerMs: 10,
      log: new RecordingLog(),
    });
    const words = await collect(
      lane.reply(
        [{ role: 'user', content: 'all good?' }],
        new AbortController().signal,
        'conv_4',
      ),
    );
    expect(words).toHaveLength(3);
    expect(FILLERS).toContain(words[0]?.trimEnd() ?? '');
    expect(words[0]?.endsWith(' ')).toBe(true);
    expect(words.slice(1)).toEqual(['all ', 'good']);
  });

  test('says no filler when the model is quick, when fillerMs is 0, or when the caller asks for none', async () => {
    const quick = modelVoiceLane({
      models: fakeModels('words').models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      fillerMs: 40,
      log: new RecordingLog(),
    });
    const off = modelVoiceLane({
      models: fakeModels('words', 40).models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      fillerMs: 0,
      log: new RecordingLog(),
    });
    const asked = modelVoiceLane({
      models: fakeModels('silent-tool', 40).models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      fillerMs: 10,
      log: new RecordingLog(),
    });
    const turns = [{ role: 'user' as const, content: 'all good?' }];
    const signal = new AbortController().signal;
    expect(await collect(quick.reply(turns, signal, 'conv_5'))).toEqual([
      'all ',
      'good',
    ]);
    expect(await collect(off.reply(turns, signal, 'conv_5'))).toEqual([
      'all ',
      'good',
    ]);
    expect(
      await collect(
        asked.reply(turns, signal, 'conv_5', [STATUS], { fillers: false }),
      ),
    ).toEqual(['all ', 'good']);
  });

  test('acknowledges once when the model starts tool rounds without a word', async () => {
    const { models, calls } = fakeModels('silent-tool');
    const log = new RecordingLog();
    const lane = modelVoiceLane({
      models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      fillerMs: 0,
      log,
    });
    const words = await collect(
      lane.reply(
        [{ role: 'user', content: 'check the backups' }],
        new AbortController().signal,
        'conv_6',
        [STATUS],
      ),
    );
    expect(words).toEqual([`${TOOL_ACK} `, 'all ', 'good']);
    expect(calls).toHaveLength(3);
    expect(log.of('voice lane: answered')[0]?.fields).toMatchObject({
      tools: 2,
      filler: false,
      ack: true,
    });
  });

  test('a slow silent tool round gets the filler and then the acknowledgement', async () => {
    const { models } = fakeModels('silent-tool', 40);
    const lane = modelVoiceLane({
      models,
      model: MODEL,
      thinking: 'off',
      timeoutMs: 5_000,
      fillerMs: 10,
      log: new RecordingLog(),
    });
    const words = await collect(
      lane.reply(
        [{ role: 'user', content: 'check the backups' }],
        new AbortController().signal,
        'conv_7',
        [STATUS],
      ),
    );
    expect(words).toHaveLength(4);
    expect(FILLERS).toContain(words[0]?.trimEnd() ?? '');
    expect(words.slice(1)).toEqual([`${TOOL_ACK} `, 'all ', 'good']);
  });
});
