/**
 * What a voice can do: start work in a text thread, ask how it is going, and
 * read mate's other threads. Work from a call is gated twice: only when the
 * owner is alone in the channel with mate, and only after the task was read
 * back and the owner's next words were a yes. The tools run in mate's own
 * process and answer in a sentence; the work itself runs in the thread, with
 * its sandbox, cards and Stop button, as a typed message would.
 */
import { type Static, type TSchema, Type } from '@earendil-works/pi-ai';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { RecallSource } from './recall.ts';
import { recallTools } from './recall.ts';
import type { ThreadState } from './threads.ts';

export const START_TASK_TOOL = 'start_task';
export const TASK_STATUS_TOOL = 'task_status';
/** The owner's words that confirm a read-back. */
const YES =
  /^(yes|yeah|yep|yup|do it|go ahead|go for it|sure|confirm|confirmed|please do|ok|okay)\b/i;

/** A tool the voice lane may call. `execute` answers in text for the model. */
export interface VoiceTool<TParameters extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
  /** True for a tool that changes something; such a tool is withheld when the owner is not alone. */
  readonly sideEffect: boolean;
  execute(args: Static<TParameters>): Promise<string>;
}

/** A task started from this call. */
export interface StartedTask {
  /** The thread key: the call's thread, which every task of the call runs in. */
  readonly key: string;
  readonly task: string;
  readonly startedAt: number;
}

/** What the tools need of the call and of mate. */
export interface VoiceWork {
  /** Posts the task in the call's thread and runs it there; resolves to the thread key. */
  startTask(task: string): Promise<string>;
  threadState(key: string): ThreadState | undefined;
  recall: RecallSource | null;
  now(): number;
}

export interface VoiceToolContext {
  /** The owner is the only one in the channel with mate. */
  alone(): boolean;
  /** The owner's last committed words. */
  lastHeard(): string;
  started: StartedTask[];
}

const START_PARAMETERS = Type.Object({
  task: Type.String({
    description:
      'The work, in the words the owner used, as the opening message of a text thread.',
  }),
  readOnly: Type.Optional(
    Type.Boolean({
      description:
        'True when the task only looks things up and reports, changing nothing; it then starts at once, with no read-back.',
    }),
  ),
});

const STATUS_PARAMETERS = Type.Object({});

function state(work: VoiceWork, task: StartedTask): string {
  const s = work.threadState(task.key);
  if (s === 'turn' || s === 'opening' || s === 'waiting')
    return 'still running';
  if (s === 'idle' || s === 'closed' || s === 'releasing') return 'finished';
  if (s === undefined) return 'finished';
  return s;
}

function clip(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The lane's tools for one call. */
export function voiceTools(
  work: VoiceWork,
  context: VoiceToolContext,
): VoiceTool[] {
  let pending: string | null = null;
  const start: VoiceTool<typeof START_PARAMETERS> = {
    name: START_TASK_TOOL,
    description:
      "Start work in the call's text thread, where mate has its tools. A read-only task (readOnly true: look something up, check, report) starts at once. Anything that changes something is read back first: the first call only records the task, you read it back to the owner in one sentence and ask for a yes, and the work starts on a second call after the owner says yes. The result is announced on the call when the work settles.",
    parameters: START_PARAMETERS,
    sideEffect: true,
    execute: async ({ task, readOnly }) => {
      const words = task.trim();
      if (!words) return 'No task was given.';
      if (!context.alone()) {
        pending = null;
        return 'Someone else is in the channel, so no work starts from the call. The owner can type it in a thread.';
      }
      if (readOnly) pending = words;
      if (
        pending === null ||
        (!readOnly && !YES.test(context.lastHeard().trim()))
      ) {
        pending = words;
        return `Not started yet. Read the task back to the owner in one sentence and ask whether to go ahead: "${clip(words)}". Call start_task again once they say yes.`;
      }
      const confirmed = pending;
      pending = null;
      let key: string;
      try {
        key = await work.startTask(confirmed);
      } catch (error) {
        return `The thread could not be started: ${(error as Error).message}. Tell the owner to type it instead.`;
      }
      context.started.push({ key, task: confirmed, startedAt: work.now() });
      return "Started in the call's thread. Tell the owner in a few words that it is under way and that you will say when it is done.";
    },
  };
  const status: VoiceTool<typeof STATUS_PARAMETERS> = {
    name: TASK_STATUS_TOOL,
    description:
      'How the work started from this call is going: each task and whether it is still running or finished. Details are in its thread.',
    parameters: STATUS_PARAMETERS,
    sideEffect: false,
    execute: async () => {
      if (context.started.length === 0)
        return 'No work has been started from this call.';
      return context.started
        .map((task) => `- "${clip(task.task)}": ${state(work, task)}`)
        .join('\n');
    },
  };
  const tools: VoiceTool[] = [start as VoiceTool, status as VoiceTool];
  if (work.recall) {
    for (const tool of recallTools(work.recall, work.now)) {
      tools.push(fromRegistration(tool));
    }
  }
  return tools;
}

/** A read-only brain tool as a voice tool: its text is the answer. */
function fromRegistration(tool: ToolRegistration): VoiceTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    sideEffect: false,
    execute: async (args) => {
      const result = await tool.execute(args, {} as never, {} as never);
      return (result.content ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n')
        .trim();
    },
  };
}

/** The last assistant text of a thread's transcript, for an announcement. */
export async function lastSaid(
  recall: RecallSource,
  key: string,
): Promise<string | null> {
  const messages = await recall.messages(key);
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;
    const text = message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return null;
}
