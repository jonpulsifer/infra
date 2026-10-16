/**
 * The voice lane: the model calls behind one spoken turn, with the call's
 * transcript as the whole context. The model may call the call's tools; each
 * round of calls runs in mate's own process and the answers go back for the
 * next round, a few rounds at most, all within one time budget. Text the
 * model says before a tool call is spoken while the tool runs. A turn that
 * stays silent too long opens with a filler, and a tool round the model
 * starts without a word opens with an acknowledgement, so the caller hears
 * that mate heard.
 */
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Models,
  normalizeContext,
  type ModelThinkingLevel as ThinkingLevel,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from '@earendil-works/pi-ai';
import type { Log } from './log.ts';
import type { Turn, VoiceLane } from './speech-engine.ts';
import type { VoiceTool } from './voice-tools.ts';

export const VOICE_PROMPT = `You are mate, speaking aloud in a Discord voice call with the owner of this homelab. Your words are read out by a text-to-speech voice in the owner's own voice.
Answer in one or two short sentences of plain spoken English. No lists, no headings, no markdown, no code, no URLs, no ids read aloud.
You have a few tools. Say a few words before calling one, and keep the answer short after it. When the owner asks for work, call start_task right away rather than describing what you would do or asking first. Work that takes longer than a moment goes to a text thread through start_task: the first call records the task, you read it back and ask for a yes, and after the owner says yes you call start_task again. When the owner is not alone in the channel, start_task refuses; say so and move on.`;

/** Rounds of tool calls in one spoken turn. */
export const TOOL_ROUNDS = 3;

/** Said when the model is slow to start; flat, never eager. */
export const FILLERS = ['Hmm.', 'Let me think.', 'One sec.', 'Right.'];
/** Said when a tool round starts before the model has said a word. */
export const TOOL_ACK = 'On it.';
export const FILLER_MS = 1_200;
const LATE = Symbol('late');

export interface ModelVoiceLaneOptions {
  models: Pick<Models, 'streamSimple'>;
  model: Model<Api>;
  thinking: ThinkingLevel;
  /** The whole reply, first token included, tool rounds included. */
  timeoutMs: number;
  /** Silence before the first word that earns a filler; 0 for none. */
  fillerMs?: number;
  log: Log;
}

const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The transcript as pi messages: what was heard, and what mate said. */
function messages(turns: readonly Turn[], model: Model<Api>): Message[] {
  const now = Date.now();
  return turns.map((turn, index): Message => {
    if (turn.role === 'user') {
      const user: UserMessage = {
        role: 'user',
        content: turn.content,
        timestamp: now + index,
      };
      return user;
    }
    const said: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: turn.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: NO_USAGE,
      stopReason: 'stop',
      timestamp: now + index,
    };
    return said;
  });
}

/** `next`'s value, or `LATE` once `ms` pass first. */
async function within<T>(
  next: Promise<T>,
  ms: number,
): Promise<T | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), ms);
  });
  try {
    return await Promise.race([next, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(
  tools: readonly VoiceTool[],
  call: ToolCall,
  log: Log,
): Promise<ToolResultMessage> {
  const tool = tools.find((one) => one.name === call.name);
  let text: string;
  let isError = false;
  if (!tool) {
    text = `There is no tool named ${call.name}.`;
    isError = true;
  } else {
    try {
      text = await tool.execute(call.arguments);
    } catch (error) {
      text = `${call.name} failed: ${(error as Error).message}`;
      isError = true;
    }
  }
  log.info('voice lane: tool', { name: call.name, isError });
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.now(),
  };
}

export function modelVoiceLane(options: ModelVoiceLaneOptions): VoiceLane {
  const { models, model, thinking, timeoutMs, log } = options;
  const fillerMs = options.fillerMs ?? FILLER_MS;
  return {
    async *reply(turns, signal, conversationId, tools = [], say = {}) {
      const history: Message[] = messages(turns, model);
      const started = Date.now();
      let first: number | null = null;
      let calls = 0;
      const fillers = say.fillers ?? true;
      // Anything said yet: the model's words, a filler or the acknowledgement.
      let heard = false;
      let filler = false;
      let ack = false;
      for (let round = 0; round <= TOOL_ROUNDS; round++) {
        const context: Context = {
          systemPrompt: VOICE_PROMPT,
          messages: history,
          ...(tools.length > 0 && round < TOOL_ROUNDS
            ? {
                tools: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              }
            : {}),
        };
        const left = timeoutMs - (Date.now() - started);
        if (left <= 0) throw new Error('the voice lane ran out of time');
        const stream = models.streamSimple(model, normalizeContext(context), {
          signal,
          timeoutMs: left,
          sessionId: conversationId,
          ...(thinking === 'off' ? {} : { reasoning: thinking }),
        });
        const pending: ToolCall[] = [];
        const events = stream[Symbol.asyncIterator]();
        let next = events.next();
        for (;;) {
          const step =
            heard || !fillers || fillerMs <= 0
              ? await next
              : await within(next, fillerMs - (Date.now() - started));
          if (step === LATE) {
            heard = true;
            filler = true;
            if (!signal.aborted) {
              yield `${FILLERS[Math.floor(Math.random() * FILLERS.length)]} `;
            }
            continue;
          }
          if (step.done) break;
          next = events.next();
          const event = step.value;
          if (event.type === 'text_delta') {
            first ??= Date.now() - started;
            heard = true;
            yield event.delta;
          } else if (
            event.type === 'toolcall_start' ||
            event.type === 'toolcall_end'
          ) {
            if (fillers && first === null && !ack) {
              heard = true;
              ack = true;
              yield `${TOOL_ACK} `;
            }
            if (event.type === 'toolcall_end') pending.push(event.toolCall);
          } else if (event.type === 'error') {
            throw new Error(event.error.errorMessage ?? event.reason);
          }
        }
        if (pending.length === 0) break;
        // The whole assistant message, tool calls included, for the next round.
        history.push(await stream.result());
        for (const call of pending) {
          if (signal.aborted) return;
          calls += 1;
          history.push(await run(tools, call, log));
        }
      }
      log.info('voice lane: answered', {
        firstTokenMs: first,
        tools: calls,
        filler,
        ack,
      });
    },
  };
}
