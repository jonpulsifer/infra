import { describe, expect, test } from 'bun:test';
import {
  CHUNK_BUDGET,
  MESSAGE_CAP,
  Reply,
  STATUS_MAX,
  splitAt,
  statusLine,
} from '../src/reply.ts';
import { FakeClock, FakeDiscord } from './support.ts';

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

  test('a status line plus a full chunk never exceeds the message cap', () => {
    const status = statusLine('x'.repeat(500));
    expect(status.length).toBeLessThanOrEqual(STATUS_MAX + 2);
    expect(`${status}\n\n`.length + CHUNK_BUDGET).toBeLessThanOrEqual(
      MESSAGE_CAP,
    );
  });

  test('a status line is one italic line without stray asterisks', () => {
    expect(statusLine(' running\n`x` **now** ')).toBe('*running `x` now*');
  });
});

describe('a streamed reply', () => {
  test('flushes the first change at once, coalesces the rest, and drops the status and button on finish', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord, clock, 't', 1_000);
    reply.update({ kind: 'status', line: 'reading files' });
    await clock.advance(0);
    const [message] = discord.inThread('t');
    expect(message!.content).toBe('*reading files*');
    expect(message!.hasStop).toBe(true);
    reply.update({ kind: 'text', delta: 'a' });
    reply.update({ kind: 'text', delta: 'b' });
    await clock.advance(999);
    expect(message!.edits).toBe(0);
    await clock.advance(1);
    expect(message!.content).toBe('*reading files*\n\nab');
    expect(message!.edits).toBe(1);
    await reply.finish('done');
    expect(message!.content).toBe('ab');
    expect(message!.hasStop).toBe(false);
  });

  test('a stopped reply with no text still says so', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord, clock, 't', 1_000);
    reply.update({ kind: 'status', line: 'thinking' });
    await clock.advance(0);
    await reply.finish('stopped');
    expect(discord.contentsIn('t')).toEqual(['*stopped*']);
  });

  test('seals full chunks in order and keeps the button only on the live message', async () => {
    const clock = new FakeClock();
    const discord = new FakeDiscord();
    const reply = new Reply(discord, clock, 't', 1_000);
    const text = 'word '.repeat(1_000);
    reply.update({ kind: 'text', delta: text });
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
});
