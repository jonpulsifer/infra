import type { API } from '@discordjs/core';
import {
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  ButtonStyle,
  ComponentType,
} from 'discord-api-types/v10';

export type StopRow = APIActionRowComponent<APIButtonComponentWithCustomId>;

export interface OutMessage {
  content: string;
  components?: StopRow[];
}

/** One message already in a thread, as the transcript replay reads it. */
export interface HistoryMessage {
  id: string;
  authorId: string;
  authorName: string;
  authorIsBot: boolean;
  content: string;
}

export interface HistoryQuery {
  limit: number;
  /** Only messages older than this id, which is how Discord pages backwards. */
  before?: string;
}

/** What the thread engine asks of Discord; the fake in tests records it. */
export interface Discord {
  createThread(
    channelId: string,
    messageId: string,
    name: string,
  ): Promise<string>;
  createMessage(channelId: string, body: OutMessage): Promise<string>;
  /** A thread's messages, newest first, as Discord returns them. */
  history(channelId: string, query: HistoryQuery): Promise<HistoryMessage[]>;
  editMessage(
    channelId: string,
    messageId: string,
    body: OutMessage,
  ): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  joinThread(threadId: string): Promise<void>;
  showTyping(channelId: string): Promise<void>;
  ackUpdate(interactionId: string, token: string): Promise<void>;
}

export const STOP_PREFIX = 'stop:';

export function stopRow(threadId: string): StopRow {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        label: 'Stop',
        custom_id: `${STOP_PREFIX}${threadId}`,
      },
    ],
  };
}

const NO_MENTIONS = { parse: [] as never[] };
/** Discord's own retries stay inside this; the replay must not stall a turn. */
const HISTORY_TIMEOUT_MS = 10_000;

export function discordOver(api: API): Discord {
  return {
    async createThread(channelId, messageId, name) {
      const thread = await api.channels.createThread(
        channelId,
        { name },
        messageId,
      );
      return thread.id;
    },
    async createMessage(channelId, body) {
      const message = await api.channels.createMessage(channelId, {
        content: body.content,
        components: body.components ?? [],
        allowed_mentions: NO_MENTIONS,
      });
      return message.id;
    },
    async history(channelId, query) {
      const messages = await api.channels.getMessages(
        channelId,
        { limit: query.limit, before: query.before },
        { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) },
      );
      return messages.map((message) => ({
        id: message.id,
        authorId: message.author.id,
        authorName: message.author.global_name ?? message.author.username,
        authorIsBot: message.author.bot ?? false,
        content: message.content,
      }));
    },
    async editMessage(channelId, messageId, body) {
      await api.channels.editMessage(channelId, messageId, {
        content: body.content,
        components: body.components ?? [],
        allowed_mentions: NO_MENTIONS,
      });
    },
    async archiveThread(threadId) {
      await api.channels.edit(threadId, { archived: true });
    },
    async joinThread(threadId) {
      await api.threads.join(threadId);
    },
    async showTyping(channelId) {
      await api.channels.showTyping(channelId);
    },
    async ackUpdate(interactionId, token) {
      await api.interactions.deferMessageUpdate(interactionId, token);
    },
  };
}
