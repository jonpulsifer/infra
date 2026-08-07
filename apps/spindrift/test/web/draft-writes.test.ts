/**
 * The draft's write side, as a decision rather than a rendering.
 *
 * Two properties that pull against each other, which is why they are one
 * module and one test rather than a debounce somebody added on top of a chain:
 *
 * - **Coalescing.** A name typed a character at a time was a round trip and a
 *   revision bump per character, and a Deploy button that flipped disabled and
 *   back on every one of them.
 * - **Order.** The draft is guarded by a revision, so two writes in flight at
 *   once means the second carries a version the first is about to invalidate —
 *   and the operator is told their own edit is a stale one from another tab.
 *
 * Deliberately not driven through the screen: the mounted harness has no event
 * system (`test/harness/dom.ts`), and typing is exactly what this coalesces.
 */
import { describe, expect, test } from 'bun:test';
import { draftWrites } from '../../src/web/views/apps/new/writes.ts';

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A save that records what it was handed and finishes when told. */
function recorder() {
  const saved: string[] = [];
  const gates: (() => void)[] = [];
  return {
    saved,
    /** Let the save that is waiting finish. */
    release: () => gates.shift()?.(),
    save: async (draft: string) => {
      saved.push(draft);
      await new Promise<void>((done) => gates.push(done));
    },
  };
}

describe('a burst of edits', () => {
  test('is one save, carrying the last one', async () => {
    const saved: string[] = [];
    const writes = draftWrites<string>({
      save: async (draft) => {
        saved.push(draft);
      },
      onWriting: () => {},
      delay: 20,
    });

    for (const value of ['a', 'al', 'alm', 'alma']) writes.edit(value);
    expect(saved).toEqual([]);

    await tick(40);
    expect(saved).toEqual(['alma']);
  });

  test('reports one stretch of writing rather than one per edit', async () => {
    // The Deploy button reads this. Flipping it per keystroke is the flicker
    // the debounce exists to remove, so `true` may not arrive until a save
    // actually leaves.
    const writing: boolean[] = [];
    const writes = draftWrites<string>({
      save: async () => {},
      onWriting: (value) => writing.push(value),
      delay: 20,
    });

    for (const value of ['a', 'al', 'alm']) writes.edit(value);
    expect(writing).toEqual([]);

    await tick(40);
    expect(writing).toEqual([true, false]);
  });

  test('the flush Deploy makes sends what is still scheduled', async () => {
    // Pressing Deploy inside the debounce window would otherwise complete the
    // draft the server holds, which is the one before the last edit.
    const saved: string[] = [];
    const writes = draftWrites<string>({
      save: async (draft) => {
        saved.push(draft);
      },
      onWriting: () => {},
      delay: 10_000,
    });

    writes.edit('almanac');
    await writes.flush();

    expect(saved).toEqual(['almanac']);
  });
});

describe('two saves', () => {
  test('never overlap, whatever order the edits arrived in', async () => {
    const recorded = recorder();
    const writes = draftWrites<string>({
      save: recorded.save,
      onWriting: () => {},
      delay: 5,
    });

    writes.edit('first');
    await tick(15);
    expect(recorded.saved).toEqual(['first']);

    // A second burst while the first save is still in flight. Nothing may go
    // out until the first has answered with the revision the second needs.
    writes.edit('second');
    await tick(15);
    expect(recorded.saved).toEqual(['first']);

    recorded.release();
    await tick(15);
    expect(recorded.saved).toEqual(['first', 'second']);

    recorded.release();
    await writes.flush();
  });

  test('a save that throws does not wedge every save after it', async () => {
    // The chain is a promise, and a rejected one stays rejected: the draft
    // would quietly stop saving for the rest of the session.
    const saved: string[] = [];
    const writes = draftWrites<string>({
      save: async (draft) => {
        saved.push(draft);
        if (draft === 'boom') throw new Error('the network went away');
      },
      onWriting: () => {},
      delay: 5,
    });

    writes.edit('boom');
    await tick(15);
    writes.edit('after');
    await writes.flush();

    expect(saved).toEqual(['boom', 'after']);
  });
});
