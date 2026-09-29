/**
 * pi's harness over this store, crashed at every commit of one turn: the
 * session reopens from Postgres alone and the turn finishes, with the tool's
 * effect at most once.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentHarness,
  type AgentMessage,
  BACKGROUND_CONTEXT,
  createWriteTool,
  type Entry,
  type Session,
  type Storage,
  StorageBackedSession,
  type Write,
} from '@earendil-works/pi-agent-core';
import {
  GatingStorage,
  InstrumentedStorage,
} from '@earendil-works/pi-agent-core/harness/session/testing';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createModels } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import {
  openSession,
  POSTGRES_STORAGE_VERSION,
  postgresStorage,
} from '../src/index.ts';
import { sessionId, withDatabase } from './support.ts';

const database = withDatabase();
const ctx = BACKGROUND_CONTEXT;
const PROMPT = 'write a note';
const ANSWER = 'the note is written';

let workspace: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pi-store-harness-'));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Asks for the note until a tool result is in the transcript, then answers. */
function model() {
  const faux = fauxProvider({ api: 'faux', tokenSize: { min: 4, max: 4 } });
  const reply = (context: { messages: { role: string }[] }) =>
    context.messages.some((message) => message.role === 'toolResult')
      ? fauxAssistantMessage(ANSWER)
      : fauxAssistantMessage(
          fauxToolCall(
            'write',
            { path: 'note.txt', content: 'hello' },
            { id: 'call-1' },
          ),
          { stopReason: 'toolUse' },
        );
  faux.setResponses(Array.from({ length: 8 }, () => reply));
  const models = createModels();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel() };
}

function harnessFor(session: Session, effects: string[]) {
  const write = createWriteTool();
  const counted: typeof write = {
    ...write,
    execute(callId, params, onUpdate, toolContext, invocation, context) {
      effects.push(params.path);
      return write.execute(
        callId,
        params,
        onUpdate,
        toolContext,
        invocation,
        context,
      );
    },
  };
  return AgentHarness.create(
    {
      session,
      ...model(),
      tools: [counted],
      toolContext: { env: new NodeExecutionEnv({ cwd: workspace }) },
      systemPrompt: 'You write notes.',
      retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
    },
    ctx,
  );
}

async function createdSession(): Promise<string> {
  const id = sessionId('turn');
  await (await openSession(database().sql, { id })).close(ctx);
  return id;
}

function sessionOver(id: string, storage: Storage): StorageBackedSession {
  return new StorageBackedSession(
    { id, createdAt: Date.now(), storageVersion: POSTGRES_STORAGE_VERSION },
    storage,
  );
}

function completed(
  result: { ok: true; value: { status: string } } | { ok: false },
): boolean {
  return result.ok && result.value.status === 'completed';
}

function text(message: AgentMessage): string {
  const content = 'content' in message ? message.content : '';
  if (typeof content === 'string') return content;
  return content.map((block) => ('text' in block ? block.text : '')).join('');
}

/** The main branch's messages, read back through a fresh session. */
async function transcript(id: string): Promise<AgentMessage[]> {
  const reopened = await openSession(database().sql, { id });
  const branch = await reopened.branch('main', ctx);
  const entries: Entry[] =
    branch === undefined
      ? []
      : await branch.findEntries({ order: 'oldestFirst' }, ctx);
  await reopened.close(ctx);
  return entries.flatMap((entry) =>
    entry.type === 'message' ? [entry.message] : [],
  );
}

async function messageEntries(id: string): Promise<number> {
  const storage = postgresStorage(database().sql, id);
  const entries = await storage.scanEntries({ type: 'message' }, ctx);
  await storage.close(ctx);
  return entries.length;
}

interface Turn {
  id: string;
  completed: boolean;
  effects: string[];
  /** The writes of each commit the turn made, in order. */
  commits: readonly Write[][];
}

/** One uninterrupted turn: the reference each crash is cut from. */
async function runTurn(): Promise<Turn> {
  const id = await createdSession();
  const storage = new InstrumentedStorage(postgresStorage(database().sql, id));
  const effects: string[] = [];
  const { harness } = await harnessFor(sessionOver(id, storage), effects);
  const lane = await harness.lane('main', ctx);
  storage.clearCommitAttempts();
  const result = await lane.prompt(PROMPT, undefined, ctx);
  await harness.close(ctx);
  return {
    id,
    completed: completed(result),
    effects,
    commits: storage.getCommitAttempts(),
  };
}

describe('the harness on Postgres', () => {
  let reference: Turn;
  beforeAll(async () => {
    reference = await runTurn();
  });

  test('runs a turn and reopens with it', async () => {
    const { id, effects, commits: turn } = reference;
    expect(reference.completed).toBe(true);

    const frames = turn.filter((writes) =>
      writes.every(
        (write) =>
          write.kind === 'list' &&
          write.namespace === 'pi.pending.assistant_frame',
      ),
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((writes) => writes.length === 1)).toBe(true);
    expect(effects).toEqual(['note.txt']);
    const said = await transcript(id);
    expect(said.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ]);
    expect(text(said.at(-1)!)).toBe(ANSWER);
  });

  test('finishes the turn after a crash at any commit', async () => {
    const turn = reference.commits;
    expect(turn.length).toBeGreaterThan(0);
    let resumes = 0;
    for (let crashAt = 0; crashAt < turn.length; crashAt++) {
      const id = await createdSession();
      const effects: string[] = [];

      const gate = new GatingStorage(postgresStorage(database().sql, id));
      const doomed = sessionOver(id, gate);
      const first = await harnessFor(doomed, effects);
      const lane = await first.harness.lane('main', ctx);
      gate.arm();
      const ended = lane.prompt(PROMPT, undefined, ctx).then(
        () => true,
        () => true,
      );
      for (let landed = 0; landed < crashAt; landed++) {
        const parked = await Promise.race([
          gate.waitPending().then(() => true),
          ended.then(() => false),
        ]);
        if (!parked) break;
        await gate.next();
      }
      await Promise.race([gate.waitPending(), ended]);
      gate.discard();
      await ended;
      await first.harness.close(ctx).catch(() => {});
      await doomed.close(ctx).catch(() => {});

      const reopened = await openSession(database().sql, { id });
      const second = await harnessFor(reopened, effects);
      const resumed = await second.harness.lane('main', ctx);
      if (second.open.length > 0) {
        expect(completed(await resumed.resume(ctx))).toBe(true);
        resumes++;
      }
      const stats = await reopened.getStats(ctx);
      await second.harness.close(ctx);
      await reopened.close(ctx);

      expect(effects.length).toBeLessThanOrEqual(1);
      expect(stats.messageCount).toBe(await messageEntries(id));
      const said = await transcript(id);
      if (said.length === 0) continue;
      expect(said.filter((message) => message.role === 'user')).toHaveLength(1);
      expect(said.at(-1)?.role).toBe('assistant');
      expect(text(said.at(-1)!)).toBe(ANSWER);
    }
    expect(resumes).toBe(turn.length - 1);
  }, 60_000);
});
