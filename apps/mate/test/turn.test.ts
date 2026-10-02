/** What a turn's events look like on a surface: text, status and cards. */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentEvent } from '@earendil-works/pi-durable';
import { SANDBOX_CARD_ID } from '../src/lease.ts';
import {
  CONNECTING,
  MINT_FAILED,
  MINT_STEPS,
  SANDBOX_LOST,
  SANDBOX_READY,
  WAITING,
} from '../src/notices.ts';
import type { PromptSink, Update } from '../src/sandbox.ts';
import {
  CARD_DELAY_MS,
  SandboxCard,
  THINKING,
  TurnTranslator,
  toolTitle,
} from '../src/turn.ts';
import { FakeClock, RecordingInstruments } from './support.ts';

class Recorder implements PromptSink {
  readonly updates: Update[] = [];
  update(update: Update): void {
    this.updates.push(update);
  }
  get text(): string {
    return this.updates.map((u) => (u.kind === 'text' ? u.delta : '')).join('');
  }
  get statuses(): (string | null)[] {
    return this.updates.flatMap((u) => (u.kind === 'status' ? [u.line] : []));
  }
  get cards() {
    return this.updates.flatMap((u) => (u.kind === 'tool' ? [u.call] : []));
  }
}

function event(fields: Record<string, unknown>): AgentEvent {
  return fields as unknown as AgentEvent;
}

const delta = (type: 'text_delta' | 'thinking_delta', text: string) =>
  event({
    type: 'message_update',
    usage: {},
    changes: [{ type, contentIndex: 0, delta: text }],
  });

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text },
  ],
  usage: { cost: { total: 0 } },
  stopReason: 'stop',
  ...extra,
});

const started = (text: string) =>
  event({ type: 'message_start', message: assistant(text) });

const ended = (message: Record<string, unknown>) =>
  event({
    type: 'message_end',
    entry: { id: 1, conversationId: 1, kind: 'pi.assistant', model: [message] },
  });

const toolStart = (id: string, toolName: string, args: unknown) =>
  event({ type: 'tool_execution_start', toolCallId: id, toolName, args });

/** `isError` null is a tool task that faulted before it wrote a result. */
const toolEnd = (
  id: string,
  toolName: string,
  isError: boolean | null = false,
) =>
  event({
    type: 'tool_execution_end',
    toolCallId: id,
    toolName,
    ...(isError === null
      ? {}
      : {
          entry: {
            id: 2,
            conversationId: 1,
            kind: 'pi.tool-result',
            model: [
              {
                role: 'toolResult',
                toolCallId: id,
                toolName,
                content: [],
                isError,
              },
            ],
          },
        }),
  });

let clock: FakeClock;
let sink: Recorder;
let metrics: RecordingInstruments;
let turn: TurnTranslator;

beforeEach(() => {
  clock = new FakeClock();
  sink = new Recorder();
  metrics = new RecordingInstruments();
  turn = new TurnTranslator(sink, clock, metrics, 3);
});

describe('a tool call has a title a human can read', () => {
  const cases: [string, unknown, string][] = [
    ['bash', { command: 'mise run lint' }, '$ mise run lint'],
    [
      'bash',
      { command: '\n  cd /workspace\nmise run lint' },
      '$ cd /workspace',
    ],
    ['bash', undefined, '$ …'],
    [
      'read',
      { path: '/workspace/docs/apps/mate.md' },
      'read docs/apps/mate.md',
    ],
    ['read', { path: '/workspace' }, 'read .'],
    ['write', { path: '/etc/hosts', content: 'x' }, 'write /etc/hosts'],
    ['edit', { path: 'AGENTS.md', edits: [] }, 'edit AGENTS.md'],
    ['edit', undefined, 'edit'],
    ['kthx_list_apps', { name: 'x' }, 'kthx: list_apps'],
    ['frobnicate', { a: 1 }, 'frobnicate'],
  ];
  for (const [name, args, title] of cases) {
    test(`${name} ${JSON.stringify(args) ?? ''} → ${title}`, () => {
      expect(toolTitle(name, args)).toBe(title);
    });
  }

  test('a long command is cut to 80 characters', () => {
    const title = toolTitle('bash', { command: `echo ${'word '.repeat(40)}` });
    expect(title).toStartWith('$ echo word word');
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe(2 + 80);
  });

  test('a secret in the arguments never reaches the card', () => {
    const key = `sk-${'a1b2c3d4'.repeat(4)}`;
    expect(
      toolTitle('bash', { command: `curl -H "Authorization: Bearer ${key}"` }),
    ).not.toContain(key);
    expect(toolTitle('bash', { command: `export OPENAI=${key}` })).toContain(
      '[redacted]',
    );
    expect(
      toolTitle('read', { path: `/workspace/${'x'.repeat(40)}.txt` }),
    ).toBe('read [redacted].txt');
  });

  test('a secret the 80-character cut would split is still redacted', () => {
    const key = '9f86d081884c7d659a2feaa0c55ad015';
    const command = `curl -s https://api.example.com/v1/items?api_key=${key}&limit=10`;
    expect(command.indexOf(key)).toBeLessThan(80);
    expect(command.indexOf(key) + key.length).toBeGreaterThan(80);
    const title = toolTitle('bash', { command });
    expect(title).not.toContain(key.slice(0, 16));
    expect(title).toContain('api_key=[redacted]');
  });
});

describe('the translator', () => {
  test('streams text and times the first token from the turn start', async () => {
    await clock.advance(1_200);
    turn.event(delta('text_delta', 'hello '));
    await clock.advance(300);
    turn.event(delta('text_delta', 'there'));
    expect(sink.text).toBe('hello there');
    expect(turn.firstTokenMs).toBe(1_200);
  });

  test('shows the model thinking only before it speaks', () => {
    turn.event(delta('thinking_delta', 'let me see'));
    expect(sink.statuses).toEqual([THINKING]);
    turn.event(delta('text_delta', 'answer'));
    turn.event(delta('thinking_delta', 'more'));
    expect(sink.statuses).toEqual([THINKING, null]);
  });

  test('a tool call is a card and the status line until it ends', () => {
    turn.event(delta('thinking_delta', 'plan'));
    turn.event(toolStart('c1', 'bash', { command: 'ls' }));
    expect(sink.cards).toEqual([
      { id: 'c1', title: '$ ls', state: 'in_progress' },
    ]);
    expect(sink.statuses.at(-1)).toBe('$ ls…');
    turn.event(toolEnd('c1', 'bash'));
    expect(sink.cards.at(-1)).toEqual({
      id: 'c1',
      title: '$ ls',
      state: 'complete',
    });
    expect(sink.statuses.at(-1)).toBe(THINKING);
    turn.event(toolStart('c2', 'read', { path: '/workspace/x' }));
    turn.event(toolEnd('c2', 'read', true));
    expect(sink.cards.at(-1)?.state).toBe('error');
    expect(metrics.tools).toEqual([
      { tool: 'bash', isError: false },
      { tool: 'read', isError: true },
    ]);
  });

  test('an abandoned turn draws nothing more, not even a pending sandbox card', async () => {
    turn.event(toolStart('c1', 'bash', { command: 'ls' }));
    turn.lease({ kind: 'connecting' });
    const drawn = sink.updates.length;
    turn.stop();
    turn.event(toolEnd('c1', 'bash', true));
    turn.event(delta('text_delta', 'late'));
    await clock.advance(CARD_DELAY_MS);
    expect(sink.updates.slice(drawn)).toEqual([]);
  });

  test('a recovered tool end it never saw start opens and closes its card in one step', () => {
    turn.event(toolEnd('c9', 'bash', null));
    turn.event(toolEnd('c10', 'read', false));
    expect(sink.cards).toEqual([
      { id: 'c9', title: '$ …', state: 'error' },
      { id: 'c10', title: 'read', state: 'complete' },
    ]);
    expect(metrics.tools).toHaveLength(2);
    expect(sink.statuses.every((line) => line === null)).toBe(true);
  });

  test('a recovered tool end takes the title of the call seeded before the resume', () => {
    const key = `sk-${'a1b2c3d4'.repeat(4)}`;
    turn.seed('c9', 'bash', { command: `curl -H "x: ${key}" && sleep 30` });
    turn.seed('c10', 'read', { path: '/workspace/notes.txt' });
    expect(sink.updates).toEqual([]);
    turn.event(toolEnd('c9', 'bash', true));
    turn.event(toolStart('c10', 'read', { path: '/workspace/other.txt' }));
    expect(sink.cards).toEqual([
      {
        id: 'c9',
        title: '$ curl -H "x: [redacted]" && sleep 30',
        state: 'error',
      },
      { id: 'c10', title: 'read other.txt', state: 'in_progress' },
    ]);
  });

  test('an answer that arrives whole is drawn once, and a streamed one is not drawn again', () => {
    turn.event(started('all at once'));
    turn.event(ended(assistant('all at once')));
    turn.event(started(''));
    turn.event(delta('text_delta', ' and'));
    turn.event(ended(assistant(' and more')));
    turn.event(ended({ role: 'user', content: 'ignored', timestamp: 0 }));
    expect(sink.text).toBe('all at once and more');
  });

  test('a partial a restart cut off is not drawn again; one this turn streamed keeps its text', () => {
    turn.event(
      ended(assistant('said before the restart', { stopReason: 'aborted' })),
    );
    expect(sink.text).toBe('');
    turn.event(started('half'));
    turn.event(ended(assistant('half an answer', { stopReason: 'aborted' })));
    expect(sink.text).toBe('half an answer');
  });

  test('a retry says so until the model answers', () => {
    turn.event(
      event({
        type: 'auto_retry_start',
        attempt: 1,
        at: 0,
        errorMessage: '529',
      }),
    );
    expect(sink.statuses.at(-1)).toBe('⏳ the model stumbled — retrying (1/3)');
    turn.event(delta('text_delta', 'ok'));
    expect(sink.statuses.at(-1)).toBeNull();
  });

  test('a request the fallback answers says why until it speaks or calls a tool', () => {
    const qwen = { provider: 'opencode-go', id: 'qwen3.8-max' } as Model<Api>;
    const sol = { provider: 'openai-codex', id: 'gpt-6-sol' } as Model<Api>;
    expect(turn.route).toBeNull();
    turn.routed({ route: 'primary', reason: null, model: sol });
    expect(turn.fellBack).toBe(false);
    turn.routed({ route: 'fallback', reason: 'limit', model: qwen });
    expect(sink.statuses.at(-1)).toBe(
      "↪️ qwen3.8-max is answering — ChatGPT's usage limit is reached",
    );
    turn.event(delta('thinking_delta', 'hmm'));
    expect(sink.statuses.at(-1)).toStartWith('↪️');
    turn.event(delta('text_delta', 'ok'));
    expect(sink.statuses.at(-1)).toBeNull();
    turn.routed({ route: 'fallback', reason: 'paused', model: qwen });
    expect(sink.statuses.at(-1)).toBe(
      '↪️ qwen3.8-max is answering — ChatGPT is paused',
    );
    turn.event(toolStart('t1', 'bash', { command: 'ls' }));
    expect(sink.statuses.at(-1)).toBe('$ ls…');
    turn.event(toolEnd('t1', 'bash', false));
    expect(sink.statuses.at(-1)).toBeNull();
    expect(turn.fellBack).toBe(true);
    expect(turn.route).toBe('mixed');
  });

  test('sums the cost of every request in the run', () => {
    const cost = (total: number) =>
      ended(assistant('', { usage: { cost: { total } } }));
    turn.event(cost(0.25));
    turn.event(cost(0.5));
    turn.event(cost(0));
    expect(turn.costUsd).toBe(0.75);
  });

  test('the run ending clears the status line', () => {
    turn.event(toolStart('c1', 'bash', { command: 'sleep 1' }));
    turn.event(event({ type: 'run_end', inputs: [1] }));
    expect(sink.statuses.at(-1)).toBeNull();
  });

  test('the sandbox card is not counted as a tool', async () => {
    turn.event(toolStart('c1', 'bash', { command: 'ls' }));
    turn.lease({ kind: 'step', step: 'creating' });
    expect(turn.toolCount).toBe(1);
  });
});

describe('the sandbox card', () => {
  let drawn: { id: string; title: string; state: string }[];
  let card: SandboxCard;

  beforeEach(() => {
    drawn = [];
    card = new SandboxCard((call) => drawn.push(call), clock);
  });

  test('a lease that is ready within a second draws nothing', async () => {
    card.event({ kind: 'step', step: 'reusing' });
    card.event({ kind: 'connecting' });
    await clock.advance(CARD_DELAY_MS - 1);
    card.event({ kind: 'ready', sandbox: 'mate-1', source: 'reused' });
    await clock.advance(5_000);
    expect(drawn).toEqual([]);
  });

  test('a slow connect is drawn after a second and closed as ready', async () => {
    card.event({ kind: 'connecting' });
    await clock.advance(CARD_DELAY_MS);
    expect(drawn).toEqual([
      { id: SANDBOX_CARD_ID, title: CONNECTING, state: 'in_progress' },
    ]);
    card.event({ kind: 'ready', sandbox: 'mate-1', source: 'reused' });
    expect(drawn.at(-1)).toEqual({
      id: SANDBOX_CARD_ID,
      title: SANDBOX_READY,
      state: 'complete',
    });
  });

  test('a mint is drawn at once, step by step', async () => {
    card.event({ kind: 'step', step: 'creating' });
    card.event({ kind: 'step', step: 'booting' });
    card.event({ kind: 'connecting' });
    card.event({ kind: 'ready', sandbox: 'mate-1', source: 'fresh' });
    expect(drawn.map((call) => call.title)).toEqual([
      MINT_STEPS.creating,
      MINT_STEPS.booting,
      CONNECTING,
      SANDBOX_READY,
    ]);
  });

  test('a wait for a slot says how many are ahead', () => {
    card.event({ kind: 'waiting', ahead: 2 });
    card.event({ kind: 'waiting', ahead: 0 });
    expect(drawn.map((call) => call.title)).toEqual([
      `${WAITING} · 2 ahead`,
      `${WAITING} · next up`,
    ]);
  });

  test('a failed mint and a lost sandbox are red', () => {
    card.event({ kind: 'failed', error: 'ImagePullBackOff' });
    card.event({ kind: 'lost', sandbox: 'mate-1', error: 'pod gone' });
    expect(drawn).toEqual([
      {
        id: SANDBOX_CARD_ID,
        title: `${MINT_FAILED}: ImagePullBackOff`,
        state: 'error',
      },
      { id: SANDBOX_CARD_ID, title: SANDBOX_LOST, state: 'error' },
    ]);
  });

  test('a card still waiting to be drawn when the turn ends never is', async () => {
    card.event({ kind: 'connecting' });
    card.end();
    await clock.advance(5_000);
    expect(drawn).toEqual([]);
  });
});
