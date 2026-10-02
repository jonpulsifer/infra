/**
 * pi-durable's Harness over this store, crashed at every commit of one turn:
 * the session reopens from Postgres alone and the turn finishes, with the
 * tool's effect at most once.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createModels, Type } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  ROOT_CONVERSATION_ID,
  type Storage,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import { openStorage } from '../src/index.ts';
import { ctx, sessionId, withDatabase } from './support.ts';

const database = withDatabase();
const PROMPT = 'write a note';
const ANSWER = 'the note is written';
const REQUEST = 'turn-1';

const CRASH_WINDOW_MS = 1_500;

/** The promise's value, or undefined when it fails or outlasts the window. */
async function within<T>(
  ms: number,
  promise: Promise<T> | undefined,
): Promise<T | undefined> {
  return Promise.race([
    (promise ?? Promise.resolve(undefined)).catch(() => undefined),
    Bun.sleep(ms).then(() => undefined),
  ]);
}

/** Delegates to `inner`, and fails every commit after the first `allowed`. */
function crashingAfter(
  inner: Storage,
  allowed: number,
): { storage: Storage; commits: StorageWrite[][] } {
  const commits: StorageWrite[][] = [];
  const storage = new Proxy(inner, {
    get(target, property) {
      if (property === 'commit') {
        return async (writes: readonly StorageWrite[], context: typeof ctx) => {
          if (commits.length >= allowed) throw new Error('process died');
          commits.push([...writes]);
          return target.commit(writes, context);
        };
      }
      const member = Reflect.get(target, property);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return { storage, commits };
}

/** Asks for the note until a tool result is in the transcript, then answers. */
async function harnessOver(storage: Storage, effects: string[]) {
  const faux = fauxProvider({ api: 'faux', tokenSize: { min: 4, max: 4 } });
  const reply = (context: { messages: readonly { role: string }[] }) =>
    context.messages.some((message) => message.role === 'toolResult')
      ? fauxAssistantMessage(ANSWER)
      : fauxAssistantMessage(
          fauxToolCall('note', { text: 'hello' }, { id: 'call-1' }),
          { stopReason: 'toolUse' },
        );
  faux.setResponses(Array.from({ length: 8 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: 'notes',
      tools: [
        defineTool({
          name: 'note',
          description: 'Write a note',
          parameters: Type.Object({ text: Type.String() }),
          execute: async (args) => {
            effects.push(args.text);
            return { content: [{ type: 'text', text: 'saved' }] };
          },
        }),
      ],
    }),
  );
  const model = faux.getModel();
  const harness = await Harness.open(storage, { models, registry }, ctx);
  const root = await harness.root(ctx, {
    agent: { model: { provider: model.provider, modelId: model.id } },
  });
  return { harness, root };
}

interface Transcript {
  kinds: string[];
  last: string | undefined;
}

async function transcript(id: string): Promise<Transcript> {
  const storage = await openStorage(database().sql, id);
  try {
    if ((await storage.conversation(ROOT_CONVERSATION_ID, ctx)) === undefined) {
      return { kinds: [], last: undefined };
    }
    const { items } = await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID },
      1000,
      undefined,
      ctx,
    );
    const entries = [...items].reverse();
    const last = entries.at(-1)?.model?.at(-1);
    return {
      kinds: entries.map((entry) => entry.kind),
      last:
        last?.role === 'assistant'
          ? last.content
              .map((part) => ('text' in part ? part.text : ''))
              .join('')
          : undefined,
    };
  } finally {
    await storage.close(ctx);
  }
}

async function runTurn(id: string, allowed: number) {
  const effects: string[] = [];
  const { storage, commits } = crashingAfter(
    await openStorage(database().sql, id),
    allowed,
  );
  const { harness, root } = await harnessOver(storage, effects).catch(() => ({
    harness: undefined,
    root: undefined,
  }));
  if (harness !== undefined) {
    const outcome = await within(
      CRASH_WINDOW_MS,
      root
        ?.submit({ type: 'input', content: PROMPT, requestId: REQUEST }, ctx)
        .then((submission) => submission.wait(ctx)),
    );
    await within(CRASH_WINDOW_MS, harness.close(ctx));
    return { effects, commits, outcome };
  }
  return { effects, commits, outcome: undefined };
}

describe('the harness on Postgres', () => {
  let commitsInTurn: number;

  beforeAll(async () => {
    const id = sessionId('reference');
    const turn = await runTurn(id, Number.POSITIVE_INFINITY);
    commitsInTurn = turn.commits.length;
    expect(turn.outcome?.status).toBe('done');
    expect(turn.effects).toEqual(['hello']);
  });

  test('runs a turn and reopens with it', async () => {
    const id = sessionId('turn');
    await runTurn(id, Number.POSITIVE_INFINITY);

    const stored = await transcript(id);

    expect(stored.kinds).toEqual([
      'pi.user',
      'pi.system',
      'pi.assistant',
      'pi.tool-result',
      'pi.assistant',
    ]);
    expect(stored.last).toBe(ANSWER);
  });

  test('finishes the turn after a crash at any commit', async () => {
    expect(commitsInTurn).toBeGreaterThan(3);
    let resumed = 0;
    for (let crashAt = 0; crashAt < commitsInTurn; crashAt++) {
      const id = sessionId(`crash-${crashAt}`);
      const effects: string[] = [];
      const doomed = await runTurn(id, crashAt);
      effects.push(...doomed.effects);
      expect(doomed.commits).toHaveLength(crashAt);

      const { harness, root } = await harnessOver(
        await openStorage(database().sql, id),
        effects,
      );
      harness.resume();
      const again = await root.submit(
        { type: 'input', content: PROMPT, requestId: REQUEST },
        ctx,
      );
      const settled = await again.wait(ctx);
      await harness.waitForIdle(ctx);
      await harness.close(ctx);
      if (doomed.outcome === undefined) resumed++;

      expect(settled.status).toBe('done');
      expect(effects.length).toBeLessThanOrEqual(1);
      const stored = await transcript(id);
      expect(stored.kinds.filter((kind) => kind === 'pi.user')).toHaveLength(1);
      expect(stored.last).toBe(ANSWER);
    }
    expect(resumed).toBe(commitsInTurn);
  }, 120_000);

  test('resume alone completes a turn a crash left unfinished', async () => {
    const id = sessionId('resume');
    await runTurn(id, commitsInTurn - 2);
    expect((await transcript(id)).last).not.toBe(ANSWER);

    const effects: string[] = [];
    const { harness } = await harnessOver(
      await openStorage(database().sql, id),
      effects,
    );
    harness.resume();
    await harness.waitForIdle(ctx);
    await harness.close(ctx);

    expect((await transcript(id)).last).toBe(ANSWER);
    expect(effects.length).toBeLessThanOrEqual(1);
  }, 30_000);
});
