/**
 * Discord as a surface. A turn in flight is one Components V2 card edited in
 * place; the last frame leaves the answer with a one-line subtext footer.
 */
import type { API } from '@discordjs/core';
import {
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
} from 'discord-api-types/v10';
import { type Clock, duration } from './clock.ts';
import { plain } from './log.ts';
import { oneLine, splitAt } from './reply.ts';
import type {
  Canvas,
  HistoryMessage,
  HistoryQuery,
  Inbound,
  Mark,
  MessageRef,
  Notice,
  Outcome,
  Surface,
  ThreadRef,
  ToolCall,
  ToolState,
} from './surface.ts';

export type StopRow = APIActionRowComponent<APIButtonComponentWithCustomId>;

/** A Components V2 message carries no `content`. */
export type OutMessage =
  | { content: string }
  | { components: APIMessageTopLevelComponent[] };

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
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  unreact(channelId: string, messageId: string, emoji: string): Promise<void>;
}

export const STOP_PREFIX = 'stop:';
/** Discord's cap on the text of one Components V2 message, all of it summed. */
export const TEXT_CAP = 4000;
/** Timeline entries a live card lists; older ones fold into a count. */
export const TOOLS_SHOWN = 6;
export const TOOL_TITLE_MAX = 90;
/** Room kept on a live card for the status line, the tool list and Stop. */
export const CARD_RESERVE = 1_000;
export const CHUNK_BUDGET = TEXT_CAP - CARD_RESERVE;
const ACCENT = 0x5865f2;
const SUBTEXT = '-# ';

const GLYPH: Record<ToolState | 'step', string> = {
  in_progress: '⟳',
  complete: '✓',
  error: '✗',
  step: '💬',
};

const MARK: Record<Mark, string> = {
  seen: '👀',
  done: '✅',
  stopped: '⏹️',
  failed: '⚠️',
};

/** Discord's small grey text, for anything that is not an answer. */
export function subtext(line: string): string {
  return `${SUBTEXT}${line}`;
}

export function stopRow(key: string): StopRow {
  return {
    type: ComponentType.ActionRow,
    components: [
      {
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: 'Stop',
        emoji: { name: '⏹️' },
        custom_id: `${STOP_PREFIX}${key}`,
      },
    ],
  };
}

function text(content: string): APITextDisplayComponent {
  return { type: ComponentType.TextDisplay, content };
}

function texts(components: readonly APIMessageTopLevelComponent[]): string[] {
  return components.flatMap((component) => {
    if (component.type === ComponentType.TextDisplay)
      return [component.content];
    if (component.type === ComponentType.Container)
      return texts(component.components);
    return [];
  });
}

/**
 * A card yields only its answer, since the rest is subtext. A plain line drops
 * its subtext mark so the notice filter's prefixes still match it.
 */
export function spoken(message: {
  content?: string;
  components?: readonly APIMessageTopLevelComponent[];
}): string {
  const displays = texts(message.components ?? []);
  if (displays.length > 0)
    return displays.filter((line) => !line.startsWith(SUBTEXT)).join('\n\n');
  const content = message.content ?? '';
  return content.startsWith(SUBTEXT) ? content.slice(SUBTEXT.length) : content;
}

const NO_MENTIONS = { parse: [] as never[] };
/** Discord's own retries stay inside this; the replay must not stall a turn. */
const HISTORY_TIMEOUT_MS = 10_000;

function wire(body: OutMessage) {
  return 'components' in body
    ? { flags: MessageFlags.IsComponentsV2, components: body.components }
    : { content: body.content, components: [] };
}

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
        ...wire(body),
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
        content: spoken(message),
      }));
    },
    async editMessage(channelId, messageId, body) {
      await api.channels.editMessage(channelId, messageId, {
        ...wire(body),
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
    async react(channelId, messageId, emoji) {
      await api.channels.addMessageReaction(channelId, messageId, emoji);
    },
    async unreact(channelId, messageId, emoji) {
      await api.channels.deleteOwnMessageReaction(channelId, messageId, emoji);
    },
  };
}

interface Entry {
  line: string;
  state: ToolState | 'step';
}

/** One card edited in place; each full chunk is sealed as its own message. */
export class DiscordCanvas implements Canvas {
  private sealed = 0;
  private liveId: string | null = null;
  private readonly timeline = new Map<string, Entry>();
  private steps = 0;
  private readonly startedAt: number;

  constructor(
    private readonly api: Discord,
    private readonly threadId: string,
    private readonly key: string,
    private readonly clock: Clock,
  ) {
    this.startedAt = clock.now();
  }

  async working(): Promise<void> {
    await this.api.showTyping(this.threadId);
  }

  /** Remembered for the next frame; the renderer's cadence does the painting. */
  async tool(call: ToolCall): Promise<void> {
    this.timeline.set(`tool:${call.id}`, {
      line: call.title,
      state: call.state,
    });
  }

  async step(line: string): Promise<void> {
    this.steps += 1;
    this.timeline.set(`step:${this.steps}`, { line, state: 'step' });
  }

  async live(answer: string, status: string | null): Promise<void> {
    const tail = await this.seal(answer);
    await this.send(this.card(tail, status));
  }

  async final(answer: string, outcome: Outcome): Promise<void> {
    const tail = await this.seal(answer);
    if (!tail && !this.liveId && outcome === 'failed') return;
    const components: APITextDisplayComponent[] = [];
    if (tail) components.push(text(tail));
    components.push(text(subtext(this.footer(outcome, !answer.trim()))));
    await this.send(components);
  }

  private card(
    tail: string,
    status: string | null,
  ): APIMessageTopLevelComponent[] {
    const entries = [...this.timeline.values()];
    const running = entries.some((entry) => entry.state === 'in_progress');
    const head: APITextDisplayComponent[] = [];
    // While a tool runs, the status is its title, which the list already shows.
    if (status && !running)
      head.push(text(subtext(`${GLYPH.in_progress} ${oneLine(status)}`)));
    if (entries.length > 0) head.push(text(checklist(entries)));
    if (head.length === 0 && !tail)
      head.push(text(subtext(`${GLYPH.in_progress} working`)));
    return [
      {
        type: ComponentType.Container,
        accent_color: ACCENT,
        components: [
          ...head,
          ...(head.length > 0 && tail
            ? [
                {
                  type: ComponentType.Separator as const,
                  divider: true,
                  spacing: SeparatorSpacingSize.Small,
                },
              ]
            : []),
          ...(tail ? [text(tail)] : []),
          stopRow(this.key),
        ],
      },
    ];
  }

  private footer(outcome: Outcome, empty: boolean): string {
    const tools = [...this.timeline.values()].filter(
      (entry) => entry.state !== 'step',
    ).length;
    const facts = [
      ...(tools > 0 ? [`${tools} tool${tools === 1 ? '' : 's'}`] : []),
      duration(this.clock.now() - this.startedAt),
    ];
    const lead =
      outcome === 'stopped'
        ? `${MARK.stopped} stopped`
        : outcome === 'failed'
          ? `${MARK.failed} failed`
          : empty
            ? `${GLYPH.complete} no reply`
            : null;
    return lead
      ? [lead, ...facts].join(' · ')
      : `${GLYPH.complete} ${facts.join(' · ')}`;
  }

  private async seal(answer: string): Promise<string> {
    let live = answer.slice(this.sealed);
    while (live.length > CHUNK_BUDGET) {
      const [head, rest] = splitAt(live, CHUNK_BUDGET);
      await this.send([text(head)]);
      this.liveId = null;
      this.sealed += head.length;
      live = rest;
    }
    return live;
  }

  private async send(components: APIMessageTopLevelComponent[]): Promise<void> {
    if (this.liveId) {
      await this.api.editMessage(this.threadId, this.liveId, { components });
    } else {
      this.liveId = await this.api.createMessage(this.threadId, { components });
    }
  }
}

function checklist(entries: readonly Entry[]): string {
  const shown = entries.slice(-TOOLS_SHOWN);
  const lines = shown.map((entry) =>
    subtext(`${GLYPH[entry.state]} ${oneLine(entry.line, TOOL_TITLE_MAX)}`),
  );
  const hidden = entries.length - shown.length;
  if (hidden > 0) lines.unshift(subtext(`… ${hidden} earlier`));
  return lines.join('\n');
}

/**
 * A message, since the typing indicator carries no words and expires after ten
 * seconds. Deleted at the end, since Discord has no empty message.
 */
export class DiscordNotice implements Notice {
  private id: string | null = null;

  constructor(
    private readonly api: Discord,
    private readonly threadId: string,
  ) {}

  async say(line: string): Promise<void> {
    const body = { content: subtext(line) };
    if (this.id) {
      await this.api.editMessage(this.threadId, this.id, body);
      return;
    }
    this.id = await this.api.createMessage(this.threadId, body);
  }

  async done(line: string | null): Promise<void> {
    if (line !== null) {
      await this.say(line);
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
  clock: Clock;
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
    async post(thread, line) {
      await api.createMessage(thread.id, { content: subtext(line) });
    },
    notice(thread) {
      return new DiscordNotice(api, thread.id);
    },
    history(thread, query) {
      return api.history(thread.id, query);
    },
    canvas(thread) {
      return new DiscordCanvas(
        api,
        thread.id,
        discordKey(thread.id),
        options.clock,
      );
    },
    archive(thread) {
      return api.archiveThread(thread.id);
    },
    mark(message, mark) {
      return markMessage(api, message, mark);
    },
  };
}

// Both reaction calls are tried; either failing throws once.
async function markMessage(
  api: Discord,
  message: MessageRef,
  mark: Mark,
): Promise<void> {
  if (mark === 'seen') {
    await api.react(message.channelId, message.id, MARK.seen);
    return;
  }
  const results = await Promise.allSettled([
    api.unreact(message.channelId, message.id, MARK.seen),
    api.react(message.channelId, message.id, MARK[mark]),
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw new Error(plain(failed.reason));
}

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

export function discordInbound(
  message: DiscordMessage,
  guildId: string,
): Inbound | null {
  if (message.guildId !== guildId) return null;
  return {
    surface: 'discord',
    id: message.id,
    channelId: message.channelId,
    // A Discord thread is itself a channel.
    threadId: message.channelId,
    authorId: message.authorId,
    authorIsBot: message.authorIsBot,
    content: message.content,
    mentionsMe: message.mentionsMe,
  };
}
