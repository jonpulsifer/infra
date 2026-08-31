/**
 * The writer, read back by the reader every release meets: spindrift's
 * `readBundle`, and the system `tar` for the long-name form.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readBundle } from '@repo/archive/bundle';
import { KthxError } from '../cli/error.ts';
import { included, pack, tarGz } from '../cli/tar.ts';

const LONG = `${'deeply/'.repeat(20)}index.html`;

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kthx-'));
  const files: Record<string, string> = {
    'index.html': '<h1>home</h1>',
    'css/style.css': 'h1{}',
    'about/index.html': '<h1>about</h1>',
    [LONG]: 'deep',
    'kthx.json': '{"name":"notes"}',
    '.env': 'SECRET=1',
    '.git/HEAD': 'ref',
    'node_modules/x/index.js': 'x',
    'empty.txt': '',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('included', () => {
  test('drops dotfiles anywhere, node_modules, and kthx.json', () => {
    expect(included('index.html')).toBe(true);
    expect(included('a/.hidden')).toBe(false);
    expect(included('.git/HEAD')).toBe(false);
    expect(included('node_modules/x.js')).toBe(false);
    expect(included('lib/node_modules/x.js')).toBe(false);
    expect(included('kthx.json')).toBe(false);
    expect(included('sub/kthx.json')).toBe(true);
  });
});

describe('pack', () => {
  test('is a gzipped ustar the bundle reader opens, sorted, with no secrets', () => {
    const dir = site();
    const packed = pack(dir);
    expect(packed.files).toBe(5);
    expect(packed.size).toBe(13 + 4 + 14 + 4);
    const read = readBundle(packed.bytes);
    expect(read.map((file) => file.path)).toEqual([
      '/about/index.html',
      '/css/style.css',
      `/${LONG}`,
      '/empty.txt',
      '/index.html',
    ]);
    expect(new TextDecoder().decode(read[4]!.bytes)).toBe('<h1>home</h1>');
    expect(read[3]!.bytes.length).toBe(0);
    expect(pack(dir).bytes).toEqual(packed.bytes);
  });

  test('carries a linked file, and refuses a dangling link', () => {
    const dir = site();
    symlinkSync('../index.html', join(dir, 'about', 'link.html'));
    expect(readBundle(pack(dir).bytes).map((file) => file.path)).toContain(
      '/about/link.html',
    );
    symlinkSync('nowhere', join(dir, 'gone.html'));
    expect(() => pack(dir)).toThrow(KthxError);
  });

  test('carries the ustar magic and a checksum tar accepts', () => {
    const tar = Bun.gunzipSync(
      tarGz([{ path: 'index.html', bytes: new TextEncoder().encode('hi') }]),
    );
    expect(new TextDecoder().decode(tar.subarray(257, 262))).toBe('ustar');
    expect(tar.length).toBe(512 * 4);
    if (Bun.which('tar') === null) return;
    const file = join(mkdtempSync(join(tmpdir(), 'kthx-')), 'site.tar.gz');
    writeFileSync(file, pack(site()).bytes);
    const listed = Bun.spawnSync(['tar', '-tzf', file]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString().trim().split('\n')).toContain(LONG);
  });
});
