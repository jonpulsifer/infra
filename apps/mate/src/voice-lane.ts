/**
 * The voice lane: one model call per spoken turn, with the transcript
 * ElevenLabs sends as the whole context. No tools yet, so nothing a voice
 * can trigger; the work lane stays on the text thread.
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
  type UserMessage,
} from '@earendil-works/pi-ai';
import type { Log } from './log.ts';
import type { Turn, VoiceLane } from './speech-engine.ts';

export const VOICE_PROMPT = `You are mate, speaking aloud in a Discord voice call with the owner of this homelab. Your words are read out by a text-to-speech voice.
Answer in one or two short sentences of plain spoken English. No lists, no headings, no markdown, no code, no URLs.
You cannot run tools or do work from this call yet. If asked for work, say so in a sentence and suggest the text thread.`;

export interface ModelVoiceLaneOptions {
  models: Pick<Models, 'streamSimple'>;
  model: Model<Api>;
  thinking: ThinkingLevel;
  /** The whole reply, first token included. */
  timeoutMs: number;
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

/** The transcript as pi messages: what ElevenLabs heard, and what mate said. */
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

export function modelVoiceLane(options: ModelVoiceLaneOptions): VoiceLane {
  const { models, model, thinking, timeoutMs, log } = options;
  return {
    async *reply(turns, signal, conversationId) {
      const context: Context = {
        systemPrompt: VOICE_PROMPT,
        messages: messages(turns, model),
      };
      const started = Date.now();
      let first: number | null = null;
      const stream = models.streamSimple(model, normalizeContext(context), {
        signal,
        timeoutMs,
        sessionId: conversationId,
        ...(thinking === 'off' ? {} : { reasoning: thinking }),
      });
      for await (const event of stream) {
        if (event.type === 'text_delta') {
          first ??= Date.now() - started;
          yield event.delta;
        } else if (event.type === 'error') {
          throw new Error(event.error.errorMessage ?? event.reason);
        }
      }
      log.info('voice lane: answered', { firstTokenMs: first });
    },
  };
}
