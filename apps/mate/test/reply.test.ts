import { describe, expect, test } from 'bun:test';
import { CARD_RESERVE, CHUNK_BUDGET, TEXT_CAP } from '../src/discord.ts';
import { silentLog } from '../src/log.ts';
import { Reply, RUN_GRACE_MS, STOPPED, splitAt } from '../src/reply.ts';
import { FakeCanvas } from './fakesurface.ts';
import { FakeClock, FakeDiscord, RecordingLog, settle } from './support.ts';

describe('the chunk rule', () => {
  test('splits at the last line break inside the budget', () => {
    const [head, tail] = splitAt('one\ntwo\nthree', 9);
    expect(head).toBe('one\ntwo\n');
    expect(tail).toBe('three');
  });

  test('hard-cuts when no line break is near the budget', () => {
    const [head, tail] = splitAt('x'.repeat(50), 20);
    expect(head).toHaveLength(20);
    expect(tail).toHaveLength(30);
  });

  test('a full chunk leaves the card its reserve under the text cap', () => {
    expect(CHUNK_BUDGET + CARD_RESERVE).toBe(TEXT_CAP);
  });
});

describe('a streamed reply', () => {
  test('flushes the first change at once, coalesces the rest, and swaps the card for a footer on finish', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(
      discord.canvas('t', clock),
      clock,
      silentLog,
      't',
      1_000,
    );
    reply.update({ kind: 'status', line: 'reading files' });
    await clock.advance(0);
    const [message] = discord.inThread('t');
    expect(message!.content).toBe('');
    expect(message!.subtext).toEqual(['-# ⟳ reading files']);
    expect(message!.hasStop).toBe(true);
    // Text becomes the answer only once it outlives RUN_GRACE_MS.
    reply.update({ kind: 'text', delta: 'a' });
    await clock.advance(RUN_GRACE_MS);
    reply.update({ kind: 'text', delta: 'b' });
    await clock.advance(0);
    expect(message!.content).toBe('ab');
    expect(message!.subtext).toEqual(['-# ⟳ reading files']);
    const edits = message!.edits;
    reply.update({ kind: 'text', delta: 'c' });
    await clock.advance(999);
    expect(message!.edits).toBe(edits);
    await clock.advance(1);
    expect(message!.content).toBe('abc');
    expect(message!.edits).toBe(edits + 1);
    await reply.finish('done');
    expect(message!.content).toBe('abc');
    expect(message!.subtext).toEqual(['-# ✓ 4s']);
    expect(message!.hasStop).toBe(false);
  });

  test('a turn whose updates all land in one tick still ends with the last frame', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const reply = new Reply(canvas, clock, silentLog, 't', 1_000);
    // Repaints queued behind an in-flight one must not be applied after finish.
    reply.update({ kind: 'status', line: 'thinking' });
    reply.update({ kind: 'text', delta: 'an answer' });
    reply.update({ kind: 'status', line: null });
    await reply.finish('done');
    expect(canvas.frames.at(-1)).toEqual({
      text: 'an answer',
      status: null,
      outcome: 'done',
    });
  });

  test('a stopped reply with no text still says so, in the footer', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord.canvas('t'), clock, silentLog, 't', 1_000);
    reply.update({ kind: 'status', line: 'thinking' });
    await clock.advance(0);
    await reply.finish('stopped');
    expect(discord.contentsIn('t')).toEqual(['']);
    expect(discord.inThread('t')[0]!.subtext).toEqual(['-# ⏹️ stopped · 0s']);
  });

  test('leaves the stopped marker to the canvas, which is told the outcome', async () => {
    const canvas = new FakeCanvas();
    const reply = new Reply(canvas, new FakeClock(), silentLog, 't', 1_000);
    reply.update({ kind: 'text', delta: 'partial' });
    await reply.finish('stopped');
    expect(canvas.frames.at(-1)).toEqual({
      text: 'partial',
      status: null,
      outcome: 'stopped',
    });
    expect(canvas.answer).not.toContain(STOPPED);
  });

  test('seals full chunks in order and keeps the button only on the live message', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord.canvas('t'), clock, silentLog, 't', 1_000);
    const text = 'word '.repeat(1_000);
    reply.update({ kind: 'text', delta: text.slice(0, 5) });
    await clock.advance(RUN_GRACE_MS);
    reply.update({ kind: 'text', delta: text.slice(5) });
    await clock.advance(0);
    const chunks = discord.inThread('t');
    expect(chunks.length).toBe(Math.ceil(text.length / CHUNK_BUDGET));
    expect(
      chunks
        .slice(0, -1)
        .every((c) => !c.hasStop && c.content.length <= CHUNK_BUDGET),
    ).toBe(true);
    expect(chunks.at(-1)!.hasStop).toBe(true);
    await reply.finish('done');
    expect(chunks.map((c) => c.content).join('')).toBe(text);
  });

  test('a turn with neither text nor status ends with a plain line, not an ellipsis', async () => {
    const discord = new FakeDiscord();
    const reply = new Reply(
      discord.canvas('t'),
      new FakeClock(),
      silentLog,
      't',
      1_000,
    );
    await reply.finish('done');
    expect(discord.contentsIn('t')).toEqual(['']);
    expect(discord.inThread('t')[0]!.subtext).toEqual(['-# ✓ no reply · 0s']);
  });

  test('a status that clears with no text behind it ends with the same plain line', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord.canvas('t'), clock, silentLog, 't', 1_000);
    reply.update({ kind: 'status', line: 'thinking' });
    await clock.advance(0);
    reply.update({ kind: 'status', line: null });
    await reply.finish('done');
    expect(discord.inThread('t')[0]!.subtext).toEqual(['-# ✓ no reply · 0s']);
  });

  test('a failed turn with nothing to show posts nothing of its own', async () => {
    const discord = new FakeDiscord();
    const reply = new Reply(
      discord.canvas('t'),
      new FakeClock(),
      silentLog,
      't',
      1_000,
    );
    await reply.finish('failed');
    expect(discord.contentsIn('t')).toEqual([]);
  });
});

describe('tool calls', () => {
  test('reach a canvas that has cards at once, in order with the text', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const reply = new Reply(canvas, clock, silentLog, 't', 1_000);
    reply.update({ kind: 'text', delta: 'a' });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'in_progress' },
    });
    await settle();
    // Cards skip the repaint cadence: they arrive at tool-call rate.
    expect(canvas.cards).toEqual([
      { id: 'c1', title: 'read files', state: 'in_progress' },
    ]);
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'complete' },
    });
    await reply.finish('done');
    expect(canvas.cards.at(-1)?.state).toBe('complete');
    expect(canvas.answer).toBe('a');
  });

  test('are listed on the Discord card, stand in for the status line, and are counted in the footer', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(
      discord.canvas('t', clock),
      clock,
      silentLog,
      't',
      1_000,
    );
    reply.update({ kind: 'status', line: 'read files…' });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'in_progress' },
    });
    await clock.advance(1_000);
    const [card] = discord.inThread('t');
    expect(card!.subtext).toEqual(['-# ⟳ read files']);
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'complete' },
    });
    reply.update({ kind: 'status', line: null });
    // A tool call's state change alone repaints.
    reply.update({
      kind: 'tool',
      call: { id: 'c2', title: 'bun test', state: 'error' },
    });
    await clock.advance(1_000);
    expect(card!.subtext).toEqual(['-# ✓ read files', '-# ✗ bun test']);
    reply.update({ kind: 'text', delta: 'an ' });
    await clock.advance(RUN_GRACE_MS);
    reply.update({ kind: 'text', delta: 'answer' });
    await clock.advance(1_000);
    expect(card!.content).toBe('an answer');
    await reply.finish('done');
    expect(discord.contentsIn('t')).toEqual(['an answer']);
    expect(card!.subtext).toEqual(['-# ✓ 2 tools · 6s']);
    expect(card!.hasStop).toBe(false);
  });

  test('fold into a count once the Discord card has listed its share', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord.canvas('t'), clock, silentLog, 't', 1_000);
    for (let i = 1; i <= 9; i += 1) {
      reply.update({
        kind: 'tool',
        call: { id: `c${i}`, title: `step ${i}`, state: 'complete' },
      });
    }
    await clock.advance(1_000);
    const lines = discord.inThread('t')[0]!.subtext;
    expect(lines[0]).toBe('-# … 3 earlier');
    expect(lines.slice(1)).toEqual(
      [4, 5, 6, 7, 8, 9].map((i) => `-# ✓ step ${i}`),
    );
  });

  test('a card that cannot be painted is one warning and still an answer', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const log = new RecordingLog();
    const reply = new Reply(canvas, clock, log, 't', 1_000);
    canvas.failTool = new Error('invalid_blocks');
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'in_progress' },
    });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'complete' },
    });
    reply.update({ kind: 'text', delta: 'the answer' });
    await clock.advance(0);
    await reply.finish('done');
    expect(log.of('a tool card could not be painted')).toHaveLength(1);
    expect(canvas.answer).toBe('the answer');
    expect(canvas.outcome).toBe('done');
  });
});

describe('what the agent says between tool calls', () => {
  test('is a step of its own, and the closing run is the answer', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const reply = new Reply(canvas, clock, silentLog, 't', 1_000);
    reply.update({ kind: 'text', delta: "I'll check the auth first." });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'gh auth status', state: 'in_progress' },
    });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'gh auth status', state: 'complete' },
    });
    reply.update({ kind: 'text', delta: 'No token here.' });
    await reply.finish('done');
    expect(canvas.steps).toEqual(["I'll check the auth first."]);
    expect(canvas.answer).toBe('No token here.');
  });

  test('fills the status line for as long as it is the run in flight', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord.canvas('t'), clock, silentLog, 't', 1_000);
    // The harness clears its status on a run's first token, so the run fills the line.
    reply.update({ kind: 'text', delta: 'Let me look at the vault item.' });
    reply.update({ kind: 'status', line: null });
    await clock.advance(0);
    const [card] = discord.inThread('t');
    expect(card!.subtext).toEqual(['-# ⟳ Let me look at the vault item.']);
    // A running tool call takes the line back from the run.
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'op read', state: 'in_progress' },
    });
    reply.update({ kind: 'status', line: 'op read…' });
    await clock.advance(1_000);
    // The sentence stays as a step on the card.
    expect(card!.subtext).toEqual([
      '-# 💬 Let me look at the vault item.',
      '-# ⟳ op read',
    ]);
    expect(card!.content).toBe('');
  });

  test('is answer text once it outlives the grace, tool call behind it or not', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const reply = new Reply(canvas, clock, silentLog, 't', 1_000);
    reply.update({ kind: 'text', delta: 'a long preamble ' });
    await clock.advance(RUN_GRACE_MS);
    reply.update({ kind: 'text', delta: 'that kept going.' });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'in_progress' },
    });
    reply.update({ kind: 'text', delta: ' The answer.' });
    await reply.finish('done');
    expect(canvas.steps).toEqual([]);
    expect(canvas.answer).toBe('a long preamble that kept going. The answer.');
  });

  test('is the answer of a turn that ended on a tool call', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const reply = new Reply(canvas, clock, silentLog, 't', 1_000);
    reply.update({ kind: 'text', delta: 'Writing the file now.' });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'write', state: 'complete' },
    });
    await reply.finish('done');
    expect(canvas.steps).toEqual(['Writing the file now.']);
    expect(canvas.answer).toBe('Writing the file now.');
  });

  test('a step card that cannot be painted is one warning and still an answer', async () => {
    const clock = new FakeClock();
    const canvas = new FakeCanvas();
    const log = new RecordingLog();
    const reply = new Reply(canvas, clock, log, 't', 1_000);
    canvas.failStep = new Error('invalid_blocks');
    reply.update({ kind: 'text', delta: 'about to look' });
    reply.update({
      kind: 'tool',
      call: { id: 'c1', title: 'read files', state: 'complete' },
    });
    reply.update({ kind: 'text', delta: 'the answer' });
    await reply.finish('done');
    expect(log.of('a step card could not be painted')).toHaveLength(1);
    expect(canvas.answer).toBe('the answer');
  });
});

describe('delivery failures', () => {
  test('a failed edit mid-stream is logged once and re-sent by the next flush', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const log = new RecordingLog();
    const reply = new Reply(discord.canvas('t'), clock, log, 't', 1_000);
    reply.update({ kind: 'text', delta: 'a' });
    await clock.advance(RUN_GRACE_MS);
    reply.update({ kind: 'text', delta: 'b' });
    await clock.advance(0);
    expect(discord.inThread('t')[0]!.content).toBe('ab');
    discord.failEdits = new Error('429 past retries');
    reply.update({ kind: 'text', delta: 'c' });
    await clock.advance(1_000);
    reply.update({ kind: 'text', delta: 'd' });
    await clock.advance(1_000);
    expect(log.of('reply edit failed; the next flush re-sends')).toHaveLength(
      1,
    );
    expect(discord.inThread('t')[0]!.content).toBe('ab');
    discord.failEdits = null;
    await reply.finish('done');
    expect(discord.inThread('t')[0]!.content).toBe('abcd');
  });

  test('a failed final send rejects finish once; a second finish is a no-op', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord.canvas('t'), clock, silentLog, 't', 1_000);
    reply.update({ kind: 'text', delta: 'a' });
    await clock.advance(0);
    discord.failEdits = new Error('thread archived');
    await expect(reply.finish('done')).rejects.toThrow('thread archived');
    await expect(reply.finish('done')).resolves.toBeUndefined();
  });
});
