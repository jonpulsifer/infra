/**
 * Upload archive normalization, checked against what a builder extracts. A bad
 * container has to be refused at upload, before a build is spent on it.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  type ArchiveFormat,
  ArchiveFormatError,
  canonicalGzip,
  normalizeArchive,
  sniffArchiveFormat,
} from '@repo/archive/archive-format';
import { zipOf } from '../fixtures/zip.ts';
import { bytes, tar, tarball } from '../harness/tar.ts';

/** Parses the tar independently of the module under test. */
function tarEntries(
  gzipped: Uint8Array,
): { path: string; text: string; mode: number; type: string }[] {
  const tar = new Uint8Array(gunzipSync(gzipped));
  const decoder = new TextDecoder();
  const out: { path: string; text: string; mode: number; type: string }[] = [];
  let pendingName: string | null = null;

  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;

    // `tar` calls an archive corrupt on a bad header checksum, which sums the
    // header with its own field read as spaces.
    const declared = Number.parseInt(
      decoder.decode(header.subarray(148, 156)).replace(/\0.*$/, '').trim(),
      8,
    );
    const check = header.slice();
    check.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of check) sum += byte;
    expect(sum).toBe(declared);

    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const size = Number.parseInt(
      decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim(),
      8,
    );
    const mode = Number.parseInt(
      decoder.decode(header.subarray(100, 108)).replace(/\0.*$/, '').trim(),
      8,
    );
    const type = String.fromCharCode(header[156] ?? 0);
    const data = tar.subarray(at + 512, at + 512 + size);

    if (type === 'L') {
      pendingName = decoder.decode(data).replace(/\0.*$/, '');
    } else {
      out.push({
        path: pendingName ?? name,
        text: decoder.decode(data),
        mode,
        type,
      });
      pendingName = null;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe('sniffArchiveFormat', () => {
  test('reads the magic number, not the filename', () => {
    expect(sniffArchiveFormat(new Uint8Array([0x1f, 0x8b, 8, 0]))).toBe('gzip');
    expect(sniffArchiveFormat(zipOf([{ path: 'a', text: 'b' }]))).toBe('zip');
    expect(
      sniffArchiveFormat(new TextEncoder().encode('<!doctype html>')),
    ).toBe(null);
    expect(sniffArchiveFormat(new Uint8Array(0))).toBe(null);
  });
});

describe('normalizeArchive', () => {
  test('passes a gzipped tar through untouched', () => {
    const already = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]);
    const normalized = normalizeArchive('bundle.tar.gz', already);
    expect(normalized.from).toBe('gzip');
    expect(normalized.bytes).toBe(already);
    expect(normalized.filename).toBe('bundle.tar.gz');
  });

  test('converts a ZIP into a tar an extractor can read', () => {
    const normalized = normalizeArchive(
      'deck.zip',
      zipOf([
        { path: 'index.html', text: '<h1>hi</h1>' },
        { path: 'assets/app.css', text: 'body{}' },
      ]),
    );

    expect(normalized.from).toBe('zip');
    // The depot object keeps this extension, so it names the new container.
    expect(normalized.filename).toBe('deck.tar.gz');
    expect(sniffArchiveFormat(normalized.bytes)).toBe('gzip');

    const entries = tarEntries(normalized.bytes);
    expect(entries.map((entry) => entry.path)).toEqual([
      'index.html',
      'assets/app.css',
    ]);
    expect(entries[0]?.text).toBe('<h1>hi</h1>');
    expect(entries[1]?.text).toBe('body{}');
  });

  test('carries the executable bit across, because a build context depends on it', () => {
    const entries = tarEntries(
      normalizeArchive(
        'src.zip',
        zipOf([
          { path: 'build.sh', text: '#!/bin/sh\n', mode: 0o755 },
          { path: 'README', text: 'no\n', mode: 0o644 },
        ]),
      ).bytes,
    );
    expect(entries[0]?.mode).toBe(0o755);
    expect(entries[1]?.mode).toBe(0o644);
  });

  test('writes a long path through the long-name entry', () => {
    const long = `${'nested/'.repeat(20)}file.txt`;
    expect(long.length).toBeGreaterThan(100);
    const entries = tarEntries(
      normalizeArchive('deep.zip', zipOf([{ path: long, text: 'deep' }])).bytes,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe(long);
    expect(entries[0]?.text).toBe('deep');
  });

  test('keeps a directory entry as a directory', () => {
    const entries = tarEntries(
      normalizeArchive(
        'dirs.zip',
        zipOf([
          { path: 'static/', text: '' },
          { path: 'static/a.txt', text: 'a' },
        ]),
      ).bytes,
    );
    expect(entries.map((entry) => entry.type)).toEqual(['5', '0']);
    expect(entries[0]?.path).toBe('static/');
  });

  test('is deterministic, so the same upload keeps its digest', () => {
    const zip = zipOf([{ path: 'index.html', text: 'same' }]);
    const first = normalizeArchive('deck.zip', zip).bytes;
    const second = normalizeArchive('deck.zip', zip).bytes;
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  test('refuses bytes that are neither, and says what arrived', () => {
    const html = new TextEncoder().encode('<!doctype html><title>oops</title>');
    let thrown: unknown;
    try {
      normalizeArchive('site.zip', html);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArchiveFormatError);
    const error = thrown as ArchiveFormatError;
    expect(error.code).toBe('UNKNOWN_FORMAT');
    expect(error.message).toContain('gzipped tar');
    expect(error.message).toContain('3c 21 64 6f');
  });

  test('refuses an entry that would write outside the bundle', () => {
    let thrown: unknown;
    try {
      normalizeArchive(
        'evil.zip',
        zipOf([{ path: '../../etc/cron.d/x', text: 'pwn' }]),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArchiveFormatError);
    expect((thrown as ArchiveFormatError).code).toBe('PATH_ESCAPES_ARCHIVE');
  });

  test('refuses a truncated ZIP rather than staging half of one', () => {
    const zip = zipOf([{ path: 'index.html', text: 'hello' }]);
    let thrown: unknown;
    try {
      normalizeArchive('cut.zip', zip.subarray(0, zip.length - 10));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ArchiveFormatError);
    expect((thrown as ArchiveFormatError).code).toBe('MALFORMED_ZIP');
  });
});

/**
 * Keyed by {@link ArchiveFormat}, so a new format fails the typecheck until it
 * has a sample.
 */
const ACCEPTED: Record<ArchiveFormat, Uint8Array> = {
  gzip: tarball([{ name: 'index.html', bytes: bytes('hi') }]),
  zip: zipOf([{ path: 'index.html', text: 'hi' }]),
};

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const FETCH_STEP = 'Fetch the staged bundle';

describe('the wire format of a staged bundle', () => {
  test('the hosted route opens it with `tar -xz`', async () => {
    const document = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
      jobs: { build: { steps: { name?: string; run?: string }[] } };
    };
    const step = document.jobs.build.steps.find((s) => s.name === FETCH_STEP);
    // The builder's half of the contract, which no type checks.
    expect(step?.run).toContain('| tar -xz');
  });

  test('every upload it accepts becomes something `tar -xz` extracts', async () => {
    for (const [format, upload] of Object.entries(ACCEPTED)) {
      const normalized = normalizeArchive(`upload.${format}`, upload);
      const workspace = await mkdtemp(join(tmpdir(), 'spindrift-bundle-'));
      try {
        // The real `tar` binary, because it is what a builder runs.
        const proc = Bun.spawn(['tar', '-xz', '-C', workspace], {
          stdin: normalized.bytes,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const code = await proc.exited;
        if (code !== 0) {
          throw new Error(
            `tar -xz refused a normalized ${format} upload: ${await new Response(proc.stderr).text()}`,
          );
        }
        expect(await readFile(join(workspace, 'index.html'), 'utf8')).toBe(
          'hi',
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  });
});

describe('canonical gzip framing', () => {
  // Two fetches of one commit can wrap an identical tar at different gzip
  // levels or header mtimes, and the staged bytes are what gets digested.
  const tarBytes = tar([
    { name: 'repo-abc123/README.md', bytes: bytes('hello') },
    { name: 'repo-abc123/build.sh', bytes: bytes('#!/bin/sh\n') },
  ]);

  test('two unstable wrappers of the same tar become one set of bytes', () => {
    const relaxed = Bun.gzipSync(tarBytes, { level: 1 });
    const eager = Bun.gzipSync(tarBytes, { level: 9 });
    // A host is also free to stamp the header's mtime field (bytes 4–7).
    eager[4] = 0x5e;
    eager[5] = 0x0b;
    expect(Bun.SHA256.hash(relaxed)).not.toEqual(Bun.SHA256.hash(eager));

    const one = canonicalGzip(relaxed);
    const two = canonicalGzip(eager);
    expect(one).toEqual(two);
  });

  test('the tar inside is untouched', () => {
    const framed = canonicalGzip(Bun.gzipSync(tarBytes, { level: 3 }));
    expect(new Uint8Array(gunzipSync(framed))).toEqual(tarBytes);
  });

  test('re-framing its own output is the identity', () => {
    // A re-staged commit must land on the same digest, or the depot grows an
    // object per fetch.
    const once = canonicalGzip(Bun.gzipSync(tarBytes));
    expect(canonicalGzip(once)).toEqual(once);
  });
});
