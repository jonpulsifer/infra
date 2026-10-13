/**
 * Evals over the session store. The ledger says what the recorded turns show
 * about each model that answered: steps, tool calls, failed tools, errors,
 * latency and cost. The decision replay asks a candidate model what it would
 * have done at each recorded tool call, with the context the recorded model
 * saw in front of it, and scores whether it picked the same tool and the same
 * action. Both read mate-db alone and touch no thread; `evals-cli.ts` prints
 * them.
 */
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Models,
  ModelThinkingLevel as ThinkingLevel,
  ToolCall,
} from '@earendil-works/pi-ai';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import { plain } from './log.ts';

export const DEFAULT_THREADS = 200;
export const DEFAULT_DECISIONS = 40;
/** pi-durable's root conversation, the one a thread's turns run in. */
const ROOT_CONVERSATION = 1;
/** The paths mate's base tools name are under the sandbox workspace. */
const WORKSPACE = '/workspace/';
// What pi-durable leaves out of a model context, and the text it puts in
// for a call whose result the history lacks (its harness/context).
const EXCLUDED_STOP_REASONS: ReadonlySet<string> = new Set([
  'aborted',
  'error',
  'deferred',
]);
const MISSING_RESULT_TEXT =
  'Tool result unavailable: history ends before this call completed.';
/** Words a command may start with before the one that says what it does. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set([
  'sudo',
  'env',
  'exec',
  'time',
  'nohup',
]);

/** A context edit as pi-durable stores it: an earlier entry omitted from the model context, or replaced. */
export type RecordedEdit =
  | { readonly target: number; readonly action: 'omit' }
  | {
      readonly target: number;
      readonly action: 'replace';
      readonly messages: readonly Message[];
    };

/** One `pi_entries` record of the root conversation, as the replay needs it. */
export interface RecordedEntry {
  readonly id: number;
  /** Set on a head marker: the entry the active context starts at. */
  readonly head: number | null;
  readonly edits: readonly RecordedEdit[];
  readonly messages: readonly Message[];
}

export interface RecordedThread {
  readonly key: string;
  readonly profile: string;
  readonly updatedAt: number;
  /** The root conversation's entries, oldest first. */
  readonly entries: readonly RecordedEntry[];
}

/** Every model message of the thread in order, heads and edits ignored: the ledger's view. */
export function allMessages(thread: RecordedThread): Message[] {
  return thread.entries.flatMap((entry) => entry.messages);
}

export interface ThreadFilter {
  readonly since: number;
  readonly until: number;
  readonly limit: number;
  readonly profile?: string;
}

interface ThreadRow {
  key: string;
  profile: string;
  updated_at: string | number;
  session_id: string;
}

/** The threads of a window, newest first, each with its root conversation's entries. */
export async function readThreads(
  sql: SQL,
  { since, until, limit, profile }: ThreadFilter,
): Promise<RecordedThread[]> {
  const rows: ThreadRow[] = await sql`
    SELECT key, COALESCE(profile, 'operator') AS profile, updated_at, session_id
    FROM mate_threads
    WHERE updated_at >= ${since} AND updated_at < ${until}
      ${profile === undefined ? sql`` : sql`AND COALESCE(profile, 'operator') = ${profile}`}
    ORDER BY updated_at DESC, key
    LIMIT ${limit}
  `;
  const threads: RecordedThread[] = [];
  for (const row of rows) {
    const entries: { id: string | number; record: string }[] = await sql`
      SELECT id, record FROM pi_entries
      WHERE session_id = ${row.session_id} AND conversation_id = ${ROOT_CONVERSATION}
      ORDER BY id
    `;
    threads.push({
      key: row.key,
      profile: row.profile,
      updatedAt: Number(row.updated_at),
      entries: entries.map((entry) =>
        recordedEntry(Number(entry.id), entry.record),
      ),
    });
  }
  return threads;
}

/** An entry from its stored record; one that is not JSON contributes nothing. */
export function recordedEntry(id: number, record: string): RecordedEntry {
  try {
    const entry = JSON.parse(record) as Partial<EntryRecord>;
    return {
      id,
      head: typeof entry.head === 'number' ? entry.head : null,
      edits: Array.isArray(entry.edits)
        ? (entry.edits as unknown as RecordedEdit[])
        : [],
      messages: Array.isArray(entry.model) ? entry.model : [],
    };
  } catch {
    return { id, head: null, edits: [], messages: [] };
  }
}

function toolCalls(message: AssistantMessage): ToolCall[] {
  return message.content.filter(
    (block): block is ToolCall => block.type === 'toolCall',
  );
}

export function specOf(message: AssistantMessage): string {
  return `${message.provider}/${message.model}`;
}

export interface LedgerRow {
  readonly model: string;
  /** Assistant messages. */
  steps: number;
  toolCalls: number;
  /** Tool results flagged as errors, charged to the model that called. */
  toolErrors: number;
  /** Steps that ended in an error. */
  errors: number;
  aborted: number;
  /** Dollars, from pi-ai's usage. */
  cost: number;
  /** Milliseconds from the message before each step to the step. */
  latencies: number[];
}

/** What the recorded steps show about each model that answered, by `provider/model`. */
export function ledger(threads: readonly RecordedThread[]): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  const rowFor = (model: string): LedgerRow => {
    let row = rows.get(model);
    if (!row) {
      row = {
        model,
        steps: 0,
        toolCalls: 0,
        toolErrors: 0,
        errors: 0,
        aborted: 0,
        cost: 0,
        latencies: [],
      };
      rows.set(model, row);
    }
    return row;
  };
  for (const thread of threads) {
    let previous: Message | null = null;
    let last: LedgerRow | null = null;
    for (const message of allMessages(thread)) {
      if (message.role === 'assistant') {
        const row = rowFor(specOf(message));
        row.steps += 1;
        row.toolCalls += toolCalls(message).length;
        if (message.stopReason === 'error') row.errors += 1;
        if (message.stopReason === 'aborted') row.aborted += 1;
        row.cost += message.usage?.cost?.total ?? 0;
        if (previous && previous.role !== 'system') {
          const ms = message.timestamp - previous.timestamp;
          if (ms >= 0) row.latencies.push(ms);
        }
        last = row;
      } else if (message.role === 'toolResult' && message.isError && last) {
        last.toolErrors += 1;
      }
      previous = message;
    }
  }
  return [...rows.values()].sort((a, b) => b.steps - a.steps);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The model context at the tail `entries[tail]`, derived as pi-durable's
 * harness derives it: the newest head marker at or before the tail starts
 * the range, the newest edit per target wins, the marker leads the range's
 * non-marker entries, an omitted entry contributes nothing, a replaced one
 * its replacement, an aborted, errored or deferred step is left out, and
 * each step's tool results follow it in call order.
 */
export function contextAt(
  entries: readonly RecordedEntry[],
  tail: number,
): Message[] {
  if (tail < 0) return [];
  const visible = entries.slice(0, tail + 1);
  const head = [...visible].reverse().find((entry) => entry.head !== null);
  const range =
    head === undefined
      ? visible
      : visible.filter((entry) => entry.id >= (head.head as number));
  const edits = new Map<number, RecordedEdit>();
  for (const entry of range) {
    for (const edit of entry.edits) edits.set(edit.target, edit);
  }
  const active =
    head === undefined
      ? range
      : [head, ...range.filter((entry) => entry.head === null)];
  const contributions = active.flatMap((entry) => {
    const edit = edits.get(entry.id);
    if (edit?.action === 'omit') return [];
    const contributed =
      edit?.action === 'replace' ? edit.messages : entry.messages;
    return contributed.filter(
      (message) =>
        message.role !== 'assistant' ||
        !EXCLUDED_STOP_REASONS.has(message.stopReason),
    );
  });
  return orderToolResults(contributions);
}

/** Each step's tool results right after it, in call order; a missing one is synthesized and an unmatched one dropped. */
export function orderToolResults(messages: readonly Message[]): Message[] {
  const ordered: Message[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index] as Message;
    index += 1;
    if (message.role === 'toolResult') continue;
    ordered.push(message);
    if (message.role !== 'assistant') continue;
    const calls = toolCalls(message);
    if (calls.length === 0) continue;
    const results = new Map<string, Message>();
    while (index < messages.length && messages[index]?.role === 'toolResult') {
      const result = messages[index] as Message & { role: 'toolResult' };
      results.set(result.toolCallId, result);
      index += 1;
    }
    for (const call of calls) {
      ordered.push(
        results.get(call.id) ?? {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: 'text', text: MISSING_RESULT_TEXT }],
          isError: true,
          timestamp: message.timestamp,
        },
      );
    }
  }
  return ordered;
}

/** A recorded tool call with what the model saw before it. */
export interface Decision {
  readonly thread: string;
  readonly profile: string;
  /** The id of the entry holding the recorded step. */
  readonly entry: number;
  readonly context: Message[];
  /** The step's first tool call; a step that called several in parallel is scored by it. */
  readonly recorded: ToolCall;
  /** The model that made the recorded call. */
  readonly by: string;
}

/**
 * Each step of the thread that called a tool, oldest first, with the context
 * pi sent for it. A context with no system message, and so no prompt and no
 * tool definitions, yields no decision: the candidate would not see what
 * the recorded model saw.
 */
export function decisions(thread: RecordedThread): Decision[] {
  const found: Decision[] = [];
  thread.entries.forEach((entry, index) => {
    const step = entry.messages.find(
      (message): message is AssistantMessage => message.role === 'assistant',
    );
    if (!step || EXCLUDED_STOP_REASONS.has(step.stopReason)) return;
    const [first] = toolCalls(step);
    if (!first) return;
    const context = contextAt(thread.entries, index - 1);
    if (!context.some((message) => message.role === 'system')) return;
    found.push({
      thread: thread.key,
      profile: thread.profile,
      entry: entry.id,
      context,
      recorded: first,
      by: specOf(step),
    });
  });
  return found;
}

/** Up to `limit` decisions, the newest of each thread in turn, so one long thread never fills the sample. */
export function sample(
  threads: readonly RecordedThread[],
  limit: number,
): Decision[] {
  const queues = threads
    .map((thread) => decisions(thread).reverse())
    .filter((queue) => queue.length > 0);
  const picked: Decision[] = [];
  while (picked.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) picked.push(next);
      if (picked.length >= limit) break;
    }
  }
  return picked;
}

function field(args: unknown, key: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/** The word of a command that says what it does: past `cd … &&`, variable assignments, sudo and the like. */
export function commandWord(command: string): string {
  let rest = command.trim();
  for (;;) {
    const cd = /^cd\s+[^&;|]*&&\s*/.exec(rest);
    if (!cd) break;
    rest = rest.slice(cd[0].length);
  }
  for (const word of rest.split(/\s+/)) {
    if (!word || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    if (COMMAND_PREFIXES.has(word) || word.startsWith('-')) continue;
    return word;
  }
  return '';
}

/**
 * What a call does, coarsely: `bash` by its command's word, a file tool by
 * its path under the workspace, any other tool by its name alone.
 */
export function action(call: ToolCall): string {
  if (call.name === 'bash') {
    const word = commandWord(field(call.arguments, 'command') ?? '');
    return word ? `bash ${word}` : 'bash';
  }
  if (['read', 'write', 'edit'].includes(call.name)) {
    const path = field(call.arguments, 'path') ?? '';
    const relative = path.startsWith(WORKSPACE)
      ? path.slice(WORKSPACE.length)
      : path;
    return relative ? `${call.name} ${relative}` : call.name;
  }
  return call.name;
}

export interface Verdict {
  readonly decision: Decision;
  /** The candidate's first tool call, or null when it answered with text alone. */
  readonly proposed: ToolCall | null;
  readonly tool: boolean;
  readonly action: boolean;
  readonly cost: number;
  readonly error: string | null;
}

export interface ReplayOptions {
  /** The candidate's reasoning level; `off` or absent sends none. */
  readonly thinking?: ThinkingLevel;
  readonly signal?: AbortSignal;
  /** Called after each decision, for progress. */
  readonly onVerdict?: (verdict: Verdict, done: number, total: number) => void;
}

/** Asks `model` each decision in turn, with the recorded context, and scores its first tool call. */
export async function replay(
  models: Models,
  model: Model<Api>,
  list: readonly Decision[],
  options: ReplayOptions = {},
): Promise<Verdict[]> {
  const verdicts: Verdict[] = [];
  const reasoning =
    options.thinking && options.thinking !== 'off'
      ? { reasoning: options.thinking }
      : {};
  for (const decision of list) {
    let verdict: Verdict;
    try {
      const reply = await models.completeSimple(
        model,
        { messages: decision.context },
        {
          ...reasoning,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (reply.stopReason === 'error') {
        throw new Error(
          reply.errorMessage ?? 'the model answered with an error',
        );
      }
      const proposed = toolCalls(reply)[0] ?? null;
      verdict = {
        decision,
        proposed,
        tool: proposed?.name === decision.recorded.name,
        action:
          proposed !== null && action(proposed) === action(decision.recorded),
        cost: reply.usage?.cost?.total ?? 0,
        error: null,
      };
    } catch (error) {
      verdict = {
        decision,
        proposed: null,
        tool: false,
        action: false,
        cost: 0,
        error: plain(error),
      };
    }
    verdicts.push(verdict);
    options.onVerdict?.(verdict, verdicts.length, list.length);
  }
  return verdicts;
}

export interface Summary {
  readonly model: string;
  readonly decisions: number;
  /** Decisions the candidate answered without an error. */
  readonly answered: number;
  readonly sameTool: number;
  readonly sameAction: number;
  /** Answered with text and no tool call. */
  readonly noTool: number;
  readonly errors: number;
  readonly cost: number;
}

export function summarize(
  model: string,
  verdicts: readonly Verdict[],
): Summary {
  const answered = verdicts.filter((v) => v.error === null);
  return {
    model,
    decisions: verdicts.length,
    answered: answered.length,
    sameTool: answered.filter((v) => v.tool).length,
    sameAction: answered.filter((v) => v.action).length,
    noTool: answered.filter((v) => v.proposed === null).length,
    errors: verdicts.length - answered.length,
    cost: verdicts.reduce((sum, v) => sum + v.cost, 0),
  };
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(header),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.map(line),
  ].join('\n');
}

function percent(part: number, whole: number): string {
  return whole === 0 ? '-' : `${Math.round((part / whole) * 100)}%`;
}

function dollars(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function renderLedger(rows: readonly LedgerRow[]): string {
  if (rows.length === 0) return 'No recorded steps in the window.';
  return table(
    [
      'model',
      'steps',
      'tool calls',
      'tool errors',
      'errors',
      'aborted',
      'median step',
      'cost',
    ],
    rows.map((row) => {
      const ms = median(row.latencies);
      return [
        row.model,
        String(row.steps),
        String(row.toolCalls),
        String(row.toolErrors),
        String(row.errors),
        String(row.aborted),
        ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`,
        dollars(row.cost),
      ];
    }),
  );
}

export function renderSummaries(rows: readonly Summary[]): string {
  if (rows.length === 0) return 'No decisions to replay in the window.';
  return table(
    [
      'candidate',
      'decisions',
      'answered',
      'same tool',
      'same action',
      'no tool',
      'errors',
      'cost',
    ],
    rows.map((row) => [
      row.model,
      String(row.decisions),
      String(row.answered),
      percent(row.sameTool, row.answered),
      percent(row.sameAction, row.answered),
      String(row.noTool),
      String(row.errors),
      dollars(row.cost),
    ]),
  );
}

/** The decisions the candidate disagreed with, one line each, naming the thread to read. */
export function renderDisagreements(verdicts: readonly Verdict[]): string {
  const lines = verdicts
    .filter((v) => v.error === null && !v.action)
    .map((v) => {
      const did = v.proposed ? action(v.proposed) : 'no tool';
      return `- ${v.decision.thread} entry ${v.decision.entry}: recorded ${action(v.decision.recorded)} (${v.decision.by}); candidate ${did}`;
    });
  return lines.length === 0 ? 'No disagreements.' : lines.join('\n');
}
