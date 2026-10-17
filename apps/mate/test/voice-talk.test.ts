import { describe, expect, test } from 'bun:test';
import { SORRY, type Turn, type VoiceLane } from '../src/speech-engine.ts';
import { Talk, TURN_CAP } from '../src/voice-talk.ts';
import { RecordingLog } from './support.ts';

/** A lane that speaks its script one word at a time, waiting on a gate between words. */
function scriptedLane(words: string[], gate?: () => Promise<void>) {
  const heard: Turn[][] = [];
  const calls: string[] = [];
  const toolNames: string[][] = [];
  const fillers: (boolean | undefined)[] = [];
  const lane: VoiceLane = {
    async *reply(turns, signal, callId, tools = [], say = {}) {
      heard.push([...turns]);
      calls.push(callId);
      toolNames.push(tools.map((t) => t.name));
      fillers.push(say.fillers);
      for (const word of words) {
        if (gate) await gate();
        if (signal.aborted) return;
        yield word;
      }
    },
  };
  return { lane, heard, calls, toolNames, fillers };
}

function harness(lane: VoiceLane | null) {
  const spoken: [string, boolean][] = [];
  const announced: string[] = [];
  const log = new RecordingLog();
  const talk = new Talk({
    callId: 'voice:c:1',
    lane,
    log,
    speak: (text, final) => spoken.push([text, final]),
    announce: (text) => announced.push(text),
    tools: [
      {
        name: 'start_task',
        description: '',
        parameters: {} as never,
        sideEffect: true,
        execute: async () => 'ok',
      },
    ],
  });
  return { talk, spoken, announced, log };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('a spoken conversation', () => {
  test('answers a committed transcript with streamed speak frames and keeps both turns', async () => {
    const { lane, heard, calls } = scriptedLane(['hi ', 'there']);
    const h = harness(lane);
    h.talk.heard('hel', false);
    h.talk.heard('hello', true);
    await settle();
    expect(h.spoken).toEqual([
      ['hi ', false],
      ['there', false],
      ['', true],
    ]);
    expect(calls).toEqual(['voice:c:1']);
    h.talk.heard('and again', true);
    await settle();
    expect(heard[1]?.map((t) => `${t.role}:${t.content}`)).toEqual([
      'user:hello',
      'agent:hi there',
      'user:and again',
    ]);
    expect(h.talk.counts).toMatchObject({
      turns: 2,
      replies: 2,
      heardChars: 17,
    });
    expect(h.log.of('voice talk: replied')[0]?.fields).toMatchObject({
      chars: 8,
      turns: 2,
    });
  });

  test('a barge-in cuts the reply and keeps only what was voiced', async () => {
    const g: { release: (() => void) | null } = { release: null };
    const gate = () =>
      new Promise<void>((resolve) => {
        g.release = resolve;
      });
    const { lane, heard } = scriptedLane(['one ', 'two ', 'three'], gate);
    const h = harness(lane);
    h.talk.heard('go', true);
    await settle();
    g.release?.();
    await settle();
    g.release?.();
    await settle();
    expect(h.spoken).toEqual([
      ['one ', false],
      ['two ', false],
    ]);
    h.talk.bargeIn(5);
    expect(h.spoken.at(-1)).toEqual(['', true]);
    g.release?.();
    await settle();
    expect(h.spoken).toHaveLength(3);
    h.talk.heard('next', true);
    await settle();
    expect(heard[1]?.map((t) => `${t.role}:${t.content}`)).toEqual([
      'user:go',
      'agent:one t',
      'user:next',
    ]);
    expect(h.talk.counts).toMatchObject({ bargeIns: 1, turns: 2 });
  });

  test('a new transcript interrupts the reply in progress', async () => {
    const g: { release: (() => void) | null } = { release: null };
    const gate = () =>
      new Promise<void>((resolve) => {
        g.release = resolve;
      });
    const { lane, heard } = scriptedLane(['slow ', 'words'], gate);
    const h = harness(lane);
    h.talk.heard('first', true);
    await settle();
    g.release?.();
    await settle();
    h.talk.heard('second', true);
    await settle();
    expect(h.talk.counts.interrupted).toBe(1);
    expect(heard[1]?.map((t) => `${t.role}:${t.content}`)).toEqual([
      'user:first',
      'agent:slow ',
      'user:second',
    ]);
  });

  test('apologises without a lane or when the lane fails, and counts it', async () => {
    const h = harness(null);
    h.talk.heard('anyone', true);
    await settle();
    expect(h.spoken).toEqual([
      [SORRY, false],
      ['', true],
    ]);
    const failing: VoiceLane = {
      // biome-ignore lint/correctness/useYield: a lane that throws before its first word
      async *reply() {
        throw new Error('boom');
      },
    };
    const g = harness(failing);
    g.talk.heard('anyone', true);
    await settle();
    expect(g.spoken).toEqual([
      [SORRY, false],
      ['', true],
    ]);
    expect(g.talk.counts.failed).toBe(1);
    expect(g.log.of('voice talk: the voice lane failed')).toHaveLength(1);
  });

  test('keeps the last turns only, and nothing after stop', async () => {
    const { lane, heard } = scriptedLane(['ok']);
    const h = harness(lane);
    for (let i = 0; i < TURN_CAP; i++) {
      h.talk.heard(`turn ${i}`, true);
      await settle();
    }
    expect(heard.at(-1)?.length).toBeLessThanOrEqual(TURN_CAP);
    expect(heard.at(-1)?.[0]?.content).not.toBe('turn 0');
    h.talk.stop();
    const before = h.spoken.length;
    h.talk.heard('after', true);
    await settle();
    expect(h.spoken.length).toBe(before);
  });

  test("hands the call's tools to the lane, and announces a settled task as an aside, without a filler", async () => {
    const { lane, heard, toolNames, fillers } = scriptedLane([
      'done, ',
      'fence up',
    ]);
    const h = harness(lane);
    h.talk.heard('go', true);
    await settle();
    expect(toolNames[0]).toEqual(['start_task']);
    await h.talk.announce('fix the fence', 'The fence is up and tested.');
    expect(h.announced).toEqual(['done, fence up']);
    expect(fillers).toEqual([undefined, false]);
    expect(heard[1]?.at(-1)?.content).toContain('one short spoken sentence');
    expect(heard[1]?.at(-2)?.content).toContain('[task result]');
    expect(h.spoken.filter(([, final]) => !final)).toHaveLength(2);
    expect(h.log.of('voice talk: announced')).toHaveLength(1);
  });

  test("a guest's words are answered by name and carry no tools", async () => {
    const { lane, heard, toolNames } = scriptedLane(['hi']);
    const h = harness(lane);
    h.talk.heard('hello', true, { id: '5', name: 'Pat', owner: false });
    await settle();
    expect(heard[0]?.map((t) => `${t.role}:${t.content}`)).toEqual([
      'user:Pat: hello',
    ]);
    expect(toolNames[0]).toEqual([]);
    expect(h.talk.lastHeard).toBe('');
    h.talk.heard('yes', true);
    await settle();
    expect(toolNames[1]).toEqual(['start_task']);
    expect(h.talk.lastHeard).toBe('yes');
  });
});
