/**
 * A cancelled `writeFile` leaves the old content or the new, never an empty
 * file. It drives `Files` directly, because a cancel sent over the pipes
 * rarely lands between the open and the write.
 */
import { afterAll, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { limitsFor } from '../src/daemon.ts';
import { Files } from '../src/files.ts';
import { removeScratch, scratch } from './support.ts';

afterAll(removeScratch);

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('a cancelled write keeps the old content or writes the new', async () => {
  const dir = scratch('cancel');
  const files = new Files(dir, limitsFor(1024));
  const path = join(dir, 'file.txt');
  const seen = new Set<string>();
  for (let trial = 0; trial < 240; trial++) {
    writeFileSync(path, 'old');
    const controller = new AbortController();
    const outcome = files.write(path, 'new', false, controller.signal).then(
      () => 'written',
      (error) => error.detail?.code ?? String(error),
    );
    await ticks(trial % 12);
    controller.abort();
    seen.add(`${await outcome}: ${readFileSync(path, 'utf8')}`);
  }
  const allowed = ['aborted: old', 'written: new'];
  expect([...seen].filter((s) => !allowed.includes(s))).toEqual([]);
});
