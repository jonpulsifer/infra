/**
 * Discord as a surface: the raw API calls the adapter makes, the canvas that
 * paints a turn into a thread by editing one message in place, and the
 * translation of a gateway message into the shape the state machine reads.
 */
import type { API } from '@discordjs/core';
import {
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  ButtonStyle,
  ComponentType,
} from 'discord-api-types/v10';
import {
  NO_REPLY,
  PLACEHOLDER,
  STATUS_MAX,
  splitAt,
  statusLine,
} from './reply.ts';
import type {
  Canvas,
  HistoryMessage,
  HistoryQuery,
  Inbound,
  Notice,
  Outcome,
  Surface,
  ThreadRef,
} from './surface.ts';

export type StopRow = APIActionRowComponent<APIButtonComponentWithCustomId>;

export interface OutMessage {
  content: string;
  components?: StopRow[];
}

/** What the Discord adapter asks of Discord; the fake in tests records it. */
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
  deleteMessage(channelId: string, messageId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  joinThread(threadId: string): Promise<void>;
  showTyping(channelId: string): Promise<void>;
  ackUpdate(interactionId: string, token: string): Promise<void>;
}

export const STOP_PREFIX = 'stop:';
export const MESSAGE_CAP = 2000;
/** Room kept on the live message for the status line and its separator. */
export const STATUS_RESERVE = STATUS_MAX + 6;
export const CHUNK_BUDGET = MESSAGE_CAP - STATUS_RESERVE;

export function stopRow(key: string): StopRow {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Danger,
        label: 'Stop',
        custom_id: `${STOP_PREFIX}${key}`,
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
    async deleteMessage(channelId, messageId) {
      await api.channels.deleteMessage(channelId, messageId);
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

/**
 * One turn in a Discord thread: a message edited in place as text arrives,
 * sealed into a new message at the cap, with the status line above the live
 * text and the Stop button below it until the turn ends.
 */
export class DiscordCanvas implements Canvas {
  private sealed = 0;
  private liveId: string | null = null;

  constructor(
    private readonly api: Discord,
    private readonly threadId: string,
    private readonly key: string,
  ) {}

  async working(): Promise<void> {
    await this.api.showTyping(this.threadId);
  }

  async live(text: string, status: string | null): Promise<void> {
    const tail = await this.seal(text);
    const header = status ? statusLine(status) : '';
    const content = [header, tail].filter(Boolean).join('\n\n') || PLACEHOLDER;
    await this.send({ content, components: [stopRow(this.key)] }, false);
  }

  async final(text: string, outcome: Outcome): Promise<void> {
    const tail = await this.seal(text);
    if (!tail && !this.liveId && outcome === 'failed') return;
    await this.send({ content: tail || NO_REPLY }, false);
  }

  /** Seals every full chunk and returns what is still live. */
  private async seal(text: string): Promise<string> {
    let live = text.slice(this.sealed);
    while (live.length > CHUNK_BUDGET) {
      const [head, rest] = splitAt(live, CHUNK_BUDGET);
      await this.send({ content: head }, true);
      this.liveId = null;
      this.sealed += head.length;
      live = rest;
    }
    return live;
  }

  private async send(body: OutMessage, seal: boolean): Promise<void> {
    if (this.liveId) {
      await this.api.editMessage(this.threadId, this.liveId, body);
    } else if (!seal || body.content) {
      this.liveId = await this.api.createMessage(this.threadId, body);
    }
  }
}

/**
 * One line in a Discord thread that mate keeps editing. It is a message
 * rather than the typing indicator because the indicator carries no words and
 * expires ten seconds after it is raised; it is deleted rather than edited
 * away at the end because Discord has no empty message, and a line saying
 * mate was starting a sandbox is worth nothing once the answer is under it.
 */
export class DiscordNotice implements Notice {
  private id: string | null = null;

  constructor(
    private readonly api: Discord,
    private readonly threadId: string,
  ) {}

  async say(text: string): Promise<void> {
    if (this.id) {
      await this.api.editMessage(this.threadId, this.id, { content: text });
      return;
    }
    this.id = await this.api.createMessage(this.threadId, { content: text });
  }

  async done(text: string | null): Promise<void> {
    if (text !== null) {
      await this.say(text);
      return;
    }
    const id = this.id;
    this.id = null;
    if (id) await this.api.deleteMessage(this.threadId, id);
  }
}

export interface DiscordSurfaceOptions {
  /** The bot user's id. */
  me: string;
  allowedUserIds: ReadonlySet<string>;
  allowedChannelIds: ReadonlySet<string>;
}

export function discordSurface(
  api: Discord,
  options: DiscordSurfaceOptions,
): Surface {
  return {
    name: 'discord',
    me: options.me,
    allowedUserIds: options.allowedUserIds,
    allowedChannelIds: options.allowedChannelIds,
    async openThread(message, title) {
      const id = await api.createThread(message.channelId, message.id, title);
      return { surface: 'discord', channelId: message.channelId, id };
    },
    async post(thread, text) {
      await api.createMessage(thread.id, { content: text });
    },
    notice(thread) {
      return new DiscordNotice(api, thread.id);
    },
    history(thread, query) {
      return api.history(thread.id, query);
    },
    canvas(thread) {
      return new DiscordCanvas(api, thread.id, discordKey(thread.id));
    },
    archive(thread) {
      return api.archiveThread(thread.id);
    },
  };
}

/** A Discord thread's key, which its id alone settles. */
export function discordKey(threadId: string): string {
  return `discord:${threadId}`;
}

export function discordThread(threadId: string, channelId = ''): ThreadRef {
  return { surface: 'discord', channelId, id: threadId };
}

/** A gateway MESSAGE_CREATE, flattened by `main.ts`. */
export interface DiscordMessage {
  id: string;
  guildId: string | null;
  channelId: string;
  authorId: string;
  authorIsBot: boolean;
  content: string;
  mentionsMe: boolean;
}

/**
 * The message as the state machine reads it, or null when it is not mate's to
 * read. A Discord thread is itself a channel, so a message in a thread names
 * the thread as its channel and nothing has to be resolved to find it.
 */
export function discordInbound(
  message: DiscordMessage,
  guildId: string,
): Inbound | null {
  if (message.guildId !== guildId) return null;
  return {
    surface: 'discord',
    id: message.id,
    channelId: message.channelId,
    threadId: message.channelId,
    authorId: message.authorId,
    authorIsBot: message.authorIsBot,
    content: message.content,
    mentionsMe: message.mentionsMe,
  };
}
