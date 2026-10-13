/**
 * Recall: what mate's threads said. `recall_threads` lists the threads active
 * in a window and `recall_thread` reads one as a transcript, from the session
 * store in mate's own process, so no sandbox reaches mate-db. The nightly
 * dream reads the day with them, and an owner's thread can look back.
 */
import { type Message, Type } from '@earendil-works/pi-ai';
import type {
  EntryRecord,
  ToolExecutionResult,
  ToolRegistration,
} from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import { plain } from './log.ts';
import { redact } from './redact.ts';

export const RECALL_THREADS_TOOL = 'recall_threads';
export const RECALL_THREAD_TOOL = 'recall_thread';
/** mate's own tools that read its threads; a profile lists both or neither. */
export const RECALL_TOOLS: readonly string[] = [
  RECALL_THREADS_TOOL,
  RECALL_THREAD_TOOL,
];
export const RECALL_LIST_MAX = 50;
/** Characters of transcript one page holds. */
export const RECALL_PAGE_CHARS = 24_000;
/** The widest window a listing reads. */
export const RECALL_WINDOW_MAX_MS = 30 * 86_400_000;
const MESSAGE_CHARS = 2_000;
const ARGS_CHARS = 300;
const RESULT_CHARS = 600;
const TITLE_CHARS = 100;

export interface RecalledThread {
  readonly key: string;
  readonly surface: string;
  readonly profile: string;
  readonly turns: number;
  readonly updatedAt: number;
  /** The thread's opening ask, redacted and clipped to one line; empty when none is kept. */
  title: string;
}

export interface RecallSource {
  /** Threads whose last change falls in [since, until), newest first. */
  threads(
    since: number,
    until: number,
    limit: number,
  ): Promise<RecalledThread[]>;
  /** The model messages of a thread's session in order, or null for a thread mate has no row for. */
  messages(key: string): Promise<Message[] | null>;
}

interface ThreadRow {
  key: string;
  surface: string;
  profile: string;
  turns: number;
  updated_at: string | number;
  /** One of the session's first entries, or null for a session with none. */
  record: string | null;
}

/** How many of a session's first entries the listing reads for the opening ask. */
const TITLE_ENTRIES = 8;

export class PostgresRecallSource implements RecallSource {
  constructor(
    private readonly sql: SQL,
    private readonly options: {
      /** What a row with no profile ran as. */
      readonly defaultProfile: string;
      /** Profiles whose threads a listing leaves out: the dream's own. */
      readonly exclude: readonly string[];
    },
  ) {}

  async threads(
    since: number,
    until: number,
    limit: number,
  ): Promise<RecalledThread[]> {
    const { defaultProfile, exclude } = this.options;
    // The records are parsed here, not cast in SQL: a `\u0000` escape in one
    // fails a jsonb cast, and one bad record must not fail the listing.
    const rows: ThreadRow[] = await this.sql`
      SELECT t.key, t.surface, COALESCE(t.profile, ${defaultProfile}) AS profile,
        t.turns, t.updated_at, e.record
      FROM (
        SELECT * FROM mate_threads
        WHERE updated_at >= ${since} AND updated_at < ${until}
          ${
            exclude.length > 0
              ? this
                  .sql`AND COALESCE(profile, ${defaultProfile}) NOT IN ${this.sql(exclude)}`
              : this.sql``
          }
        ORDER BY updated_at DESC, key
        LIMIT ${limit}
      ) t
      LEFT JOIN LATERAL (
        SELECT record FROM pi_entries
        WHERE session_id = t.session_id ORDER BY id LIMIT ${TITLE_ENTRIES}
      ) e ON true
      ORDER BY t.updated_at DESC, t.key
    `;
    const threads = new Map<string, RecalledThread>();
    for (const row of rows) {
      const thread = threads.get(row.key) ?? {
        key: row.key,
        surface: row.surface,
        profile: row.profile,
        turns: row.turns,
        updatedAt: Number(row.updated_at),
        title: '',
      };
      if (!thread.title && row.record) {
        thread.title = titleOf(entryMessages(row.record));
      }
      threads.set(row.key, thread);
    }
    return [...threads.values()];
  }

  async messages(key: string): Promise<Message[] | null> {
    const [thread]: { session_id: string }[] = await this
      .sql`SELECT session_id FROM mate_threads WHERE key = ${key}`;
    if (!thread) return null;
    const rows: { record: string }[] = await this.sql`
      SELECT record FROM pi_entries
      WHERE session_id = ${thread.session_id} ORDER BY id
    `;
    return rows.flatMap((row) => entryMessages(row.record));
  }
}

/** The messages an entry contributed to the model's context; none for a bookkeeping entry or a record that is not JSON. */
export function entryMessages(record: string): Message[] {
  try {
    const entry = JSON.parse(record) as Partial<EntryRecord>;
    return Array.isArray(entry.model) ? [...entry.model] : [];
  } catch {
    return [];
  }
}

type Block = { type: string; text?: string };

function textOf(content: string | readonly Block[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) =>
      block.type === 'text' ? (block.text ?? '') : `[${block.type}]`,
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Redacted first, so a secret cut by the clip leaves no prefix, then clipped,
 * with every later line indented so a message can never forge a transcript
 * line of its own.
 */
function clip(text: string, max: number): string {
  const one = redact(text).trim();
  const cut = one.length > max ? `${one.slice(0, max - 1)}…` : one;
  return cut.replaceAll('\n', '\n  ');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function titleOf(messages: readonly Message[]): string {
  const first = messages.find((message) => message.role === 'user');
  if (first?.role !== 'user') return '';
  return clip(oneLine(textOf(first.content)), TITLE_CHARS);
}

/**
 * A thread's session as lines: `owner:` for the asker, `you:` for the model's
 * text, `→ tool args` for a call and `← tool: result` for its result, each
 * redacted and clipped. mate's own system messages are left out.
 */
export function renderTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'user':
        lines.push(`owner: ${clip(textOf(message.content), MESSAGE_CHARS)}`);
        break;
      case 'assistant':
        for (const block of message.content) {
          if (block.type === 'text') {
            const text = clip(block.text, MESSAGE_CHARS);
            if (text) lines.push(`you: ${text}`);
          } else if (block.type === 'toolCall') {
            lines.push(
              `→ ${block.name} ${clip(JSON.stringify(block.arguments), ARGS_CHARS)}`,
            );
          }
        }
        break;
      case 'toolResult':
        lines.push(
          `← ${message.toolName}${message.isError ? ' (error)' : ''}: ${clip(textOf(message.content), RESULT_CHARS)}`,
        );
        break;
      default:
        break;
    }
  }
  // A backstop for a secret the clips have joined across lines.
  return redact(lines.join('\n'));
}

/** Page `page` of the transcript, split at line ends, and how many pages there are. */
export function pageOf(
  text: string,
  page: number,
): { text: string; pages: number } {
  const pages: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > RECALL_PAGE_CHARS) {
      pages.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current || pages.length === 0) pages.push(current);
  return { text: pages[page - 1] ?? '', pages: pages.length };
}

const THREADS_PARAMETERS = Type.Object({
  since: Type.String({
    description:
      'Start of the window, an ISO 8601 instant such as 2026-10-12T03:00:00Z.',
  }),
  until: Type.Optional(
    Type.String({
      description:
        'End of the window, ISO 8601; now when left out. At most 30 days after since.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: RECALL_LIST_MAX,
      description: `How many threads, newest first; ${RECALL_LIST_MAX} when left out.`,
    }),
  ),
});

const THREAD_PARAMETERS = Type.Object({
  key: Type.String({ description: 'A thread key from recall_threads.' }),
  page: Type.Optional(
    Type.Integer({
      minimum: 1,
      description:
        'Which page of the transcript; 1 when left out. The first line says how many there are.',
    }),
  ),
});

function said(text: string, isError = false): ToolExecutionResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function line(thread: RecalledThread): string {
  const title = thread.title ? ` · ${thread.title}` : '';
  return `- ${thread.key} · ${thread.surface} · ${thread.profile} · ${count(thread.turns, 'turn')} · last ${iso(thread.updatedAt)}${title}`;
}

/** mate's own tools over its threads. `now` bounds a window with no `until`. */
export function recallTools(
  source: RecallSource,
  now: () => number,
): ToolRegistration[] {
  const threads: ToolRegistration<typeof THREADS_PARAMETERS> = {
    name: RECALL_THREADS_TOOL,
    description:
      "List mate's threads whose last message falls in a window: every Slack and Discord thread, newest first, each with the key recall_thread reads it by, its profile, its turns and its opening ask.",
    parameters: THREADS_PARAMETERS,
    replay: 'safe',
    execute: async (args) => {
      const since = Date.parse(args.since);
      const until = args.until === undefined ? now() : Date.parse(args.until);
      if (Number.isNaN(since) || Number.isNaN(until)) {
        return said('since and until must be ISO 8601 instants.', true);
      }
      if (until <= since) return said('until must be after since.', true);
      if (until - since > RECALL_WINDOW_MAX_MS) {
        return said('The window is at most 30 days.', true);
      }
      try {
        const found = await source.threads(
          since,
          until,
          args.limit ?? RECALL_LIST_MAX,
        );
        const window = `from ${iso(since)} to ${iso(until)}`;
        if (found.length === 0) {
          return said(`No thread was active ${window}.`);
        }
        return said(
          [
            `${count(found.length, 'thread')} active ${window}:`,
            ...found.map(line),
          ].join('\n'),
        );
      } catch (error) {
        return said(
          `The threads could not be read: ${redact(plain(error))}`,
          true,
        );
      }
    },
  };
  const thread: ToolRegistration<typeof THREAD_PARAMETERS> = {
    name: RECALL_THREAD_TOOL,
    description:
      "Read one of mate's threads as a transcript: the owner's messages, your replies, your tool calls and their results, each clipped. A long transcript comes in pages.",
    parameters: THREAD_PARAMETERS,
    replay: 'safe',
    execute: async (args) => {
      const page = args.page ?? 1;
      try {
        const messages = await source.messages(args.key);
        if (!messages) return said(`mate has no thread ${args.key}.`, true);
        const rendered = renderTranscript(messages);
        if (!rendered) return said(`Thread ${args.key} holds no messages.`);
        const { text, pages } = pageOf(rendered, page);
        if (!text) {
          return said(
            `Thread ${args.key} has ${count(pages, 'page')}; page ${page} is past the end.`,
            true,
          );
        }
        return said(`[${args.key}, page ${page} of ${pages}]\n${text}`);
      } catch (error) {
        return said(
          `The thread could not be read: ${redact(plain(error))}`,
          true,
        );
      }
    },
  };
  return [threads, thread];
}
