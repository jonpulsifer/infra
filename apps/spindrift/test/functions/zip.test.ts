/**
 * The store-only ZIP writer.
 *
 * The far side here is `unzip` and Cloud Build's unpacker, neither of which can
 * be faked usefully — so the assertions are on the format itself: the CRC a
 * reader will check the bytes against, the three signatures a reader seeks by,
 * and, where the tool is installed, that a real unzip lists what went in.
 */
import { describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zip } from '../../src/functions/zip.ts';

const encoder = new TextEncoder();

function file(name: string, text: string) {
  return { name, bytes: encoder.encode(text) };
}

describe('zip', () => {
  test('carries the CRC-32 a reader will check the bytes against', () => {
    const archive = zip([file('hello.txt', 'hello')]);
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength,
    );
    expect(view.getUint32(14, true)).toBe(0x3610a686);
    // Stored, so both sizes are the input's length.
    expect(view.getUint16(8, true)).toBe(0);
    expect(view.getUint32(18, true)).toBe(5);
    expect(view.getUint32(22, true)).toBe(5);
  });

  test('writes the local, central and end signatures where a reader seeks', () => {
    const archive = zip([
      file('a.mjs', 'export default 1;'),
      file('b.json', '{}'),
    ]);
    const view = new DataView(
      archive.buffer,
      archive.byteOffset,
      archive.byteLength,
    );
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    const end = archive.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 8, true)).toBe(2);
    expect(view.getUint16(end + 10, true)).toBe(2);

    const centralOffset = view.getUint32(end + 16, true);
    expect(view.getUint32(centralOffset, true)).toBe(0x02014b50);
    expect(view.getUint32(end + 12, true)).toBe(end - centralOffset);
  });

  test('is deterministic: the same files produce the same bytes', () => {
    const once = zip([file('index.mjs', 'export default {};')]);
    const twice = zip([file('index.mjs', 'export default {};')]);
    expect(Buffer.from(once).equals(Buffer.from(twice))).toBe(true);
  });

  test('a real unzip lists every name', async () => {
    const which = Bun.spawnSync(['which', 'unzip']);
    if (which.exitCode !== 0) return;

    const path = join(tmpdir(), `spindrift-zip-${crypto.randomUUID()}.zip`);
    await Bun.write(
      path,
      zip([
        file('index.mjs', 'export default { fetch() {} };'),
        file('shim.mjs', 'import "./index.mjs";'),
        file('package.json', '{"name":"fn-demo"}'),
      ]),
    );
    try {
      const listed = Bun.spawnSync(['unzip', '-l', path]);
      expect(listed.exitCode).toBe(0);
      const text = listed.stdout.toString();
      expect(text).toContain('index.mjs');
      expect(text).toContain('shim.mjs');
      expect(text).toContain('package.json');
    } finally {
      await unlink(path);
    }
  });
});
