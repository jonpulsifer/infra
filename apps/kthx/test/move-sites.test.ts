/** The one-shot move of serving releases into the sites bucket. */
import { afterAll, describe, expect, test } from 'bun:test';
import { fakeGcs } from '@repo/archive/fake-gcs';
import { filesOf, moveSite, plan } from '../scripts/move-sites.ts';

const gcs = fakeGcs();
afterAll(() => gcs.stop());
const auth = { token: () => 'operator', endpoint: gcs.url };
const sites = { bucketName: 'sites', auth };

/** A ustar tarball, gzipped, as the old depot stored a release. */
function tarGz(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [path, text] of Object.entries(files)) {
    const bytes = new TextEncoder().encode(text);
    const header = new Uint8Array(512);
    const put = (value: string, at: number) =>
      header.set(new TextEncoder().encode(value), at);
    put(path, 0);
    put('0000644\0', 100);
    put('0000000\0', 108);
    put('0000000\0', 116);
    put(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
    put('00000000000\0', 136);
    put('0', 156);
    put('ustar\0', 257);
    put('00', 263);
    header.fill(0x20, 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header);
    const body = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    body.set(bytes);
    blocks.push(body);
  }
  blocks.push(new Uint8Array(1024));
  const whole = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    whole.set(block, at);
    at += block.length;
  }
  return Bun.gzipSync(whole);
}

describe('the plan', () => {
  test('owns each site by its login, then the file, then the default', () => {
    const rows = [
      { name: 'a', owner_login: 'Dad@Example.test', location: 'gs://d/a' },
      { name: 'b', owner_login: null, location: 'gs://d/b' },
      { name: 'c', owner_login: null, location: 'gs://d/c' },
    ];
    expect(plan(rows, { b: 'mom@example.test' }, 'ops@example.test')).toEqual([
      {
        name: 'a',
        location: 'gs://d/a',
        owner: 'dad@example.test',
        from: 'login',
      },
      {
        name: 'b',
        location: 'gs://d/b',
        owner: 'mom@example.test',
        from: 'file',
      },
      {
        name: 'c',
        location: 'gs://d/c',
        owner: 'ops@example.test',
        from: 'default',
      },
    ]);
    expect(plan(rows.slice(2), {}, null)[0]?.owner).toBeNull();
  });

  test('takes a lone top-level directory as the site', () => {
    const bytes = new Uint8Array();
    expect(
      filesOf([
        { path: '/dist/index.html', bytes },
        { path: '/dist/a.js', bytes },
      ]).map((file) => file.path),
    ).toEqual(['index.html', 'a.js']);
  });
});

describe('a move', () => {
  test('writes the release and a marker, and a second run leaves it alone', async () => {
    gcs.put(
      'depot',
      'releases/abc.tar.gz',
      tarGz({
        'index.html': '<h1>old</h1>',
        'css/site.css': 'h1{}',
      }),
    );
    const site = {
      name: 'moved',
      location: 'gs://depot/releases/abc.tar.gz',
      owner: 'dad@example.test',
      from: 'login' as const,
    };
    expect(await moveSite(auth, sites, site)).toBe('moved');
    expect(gcs.names('sites', 'moved/')).toEqual([
      'moved/.kthx',
      'moved/css/site.css',
      'moved/index.html',
    ]);
    expect(gcs.get('sites', 'moved/.kthx')?.metadata['kthx-owner']).toBe(
      'dad@example.test',
    );
    expect(gcs.get('sites', 'moved/index.html')?.contentType).toBe(
      'text/html; charset=utf-8',
    );
    expect(await moveSite(auth, sites, site)).toBe('present');
  });

  test('a release the depot no longer holds is reported, not invented', async () => {
    expect(
      await moveSite(auth, sites, {
        name: 'lost',
        location: 'gs://depot/releases/gone.tar.gz',
        owner: 'dad@example.test',
        from: 'login',
      }),
    ).toBe('missing');
    expect(gcs.names('sites', 'lost/')).toEqual([]);
  });
});
