// Draft writes coalesce a burst of edits into one save and never overlap: the
// draft is revision-guarded, so an overlapping save would be refused as stale.
import { describe, expect, test } from 'bun:test';
import { draftWrites } from '../../src/web/views/apps/new/writes.ts';

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms));

// A save that records what it was handed and finishes when released.
function recorder() {
  const saved: string[] = [];
  const gates: (() => void)[] = [];
  return {
    saved,
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
    // The Deploy button reads this, so `true` waits until a save leaves.
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
    // Otherwise Deploy inside the debounce window completes the draft before the last edit.
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

  test('and the flush after a discard sends nothing', async () => {
    const saved: string[] = [];
    const writes = draftWrites<string>({
      save: async (draft) => {
        saved.push(draft);
      },
      onWriting: () => {},
      delay: 10_000,
    });

    writes.edit('almanac');
    writes.discard();
    await writes.flush();

    expect(saved).toEqual([]);
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

    // Nothing leaves until the first save answers with the revision the second needs.
    writes.edit('second');
    await tick(15);
    expect(recorded.saved).toEqual(['first']);

    recorded.release();
    await tick(15);
    expect(recorded.saved).toEqual(['first', 'second']);

    recorded.release();
    await writes.flush();
  });

  test('one refused as stale takes the edits behind it with it', async () => {
    // Recovery replaces the draft on screen with the server's. An edit made
    // against the lost version would otherwise save at the recovered revision.
    const recorded = recorder();
    const writes = draftWrites<string>({
      save: recorded.save,
      onWriting: () => {},
      delay: 5,
    });

    writes.edit('local-a');
    await tick(15);
    expect(recorded.saved).toEqual(['local-a']);

    writes.edit('local-ab');
    await tick(15);
    writes.discard();
    recorded.release();
    await writes.flush();

    expect(recorded.saved).toEqual(['local-a']);

    // Only pending edits are dropped.
    writes.edit('recovered-and-edited');
    await tick(15);
    recorded.release();
    await writes.flush();
    expect(recorded.saved).toEqual(['local-a', 'recovered-and-edited']);
  });

  test('a save that throws does not wedge every save after it', async () => {
    // A rejected link would otherwise reject every save chained after it.
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
