/**
 * A site's files: who may write one, what may be in it, and what `/files/*`
 * hands back. A path belongs to its creator, and a type that could be a
 * document on this origin is refused.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FILES_BYTES,
} from '../../server/files.ts';
import { bodyWithin } from '../../server/http.ts';
import { ME_COOKIE } from '../../server/me.ts';
import { ask, withServer } from '../harness/server.ts';

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `198.18.0.${nextAddress % 250}`;
}

interface Site {
  readonly name: string;
  readonly host: string;
  readonly token: string;
}

async function claimed(label: string): Promise<Site> {
  return kthx().site(label);
}

interface Visitor {
  cookie?: string;
}

async function put(
  site: Site,
  path: string,
  body: BodyInit,
  init: { type?: string; as?: Visitor; token?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.type !== undefined) headers['content-type'] = init.type;
  if (init.as?.cookie !== undefined) headers.cookie = init.as.cookie;
  const response = await kthx().fetch(
    ask(`/api/files/${path}`, {
      host: site.host,
      method: 'PUT',
      headers,
      body,
      token: init.token,
      address: address(),
    }),
  );
  const set = response.headers.get('set-cookie');
  if (init.as !== undefined && set !== null) {
    init.as.cookie = set.slice(0, set.indexOf(';'));
  }
  return response;
}

function get(site: Site, path: string, init: RequestInit = {}) {
  return kthx().fetch(ask(path, { host: site.host, ...init }));
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('putting a file', () => {
  test('stores it, serves it, lists it and counts it', async () => {
    const site = await claimed('files');
    const created = await put(site, 'art/cover.png', PNG, {
      type: 'image/png',
    });
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body).toEqual({
      path: 'art/cover.png',
      url: `https://${site.host}/files/art/cover.png`,
      size: PNG.byteLength,
      type: 'image/png',
    });

    const served = await get(site, '/files/art/cover.png');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(served.headers.get('cache-control')).toBe('public, max-age=60');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-disposition')).toBe('inline');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);

    // In the depot, never in the site's folder.
    const object = join(kthx().depotDir, 'files', site.name, 'art/cover.png');
    expect((await stat(object)).isFile()).toBe(true);
    expect(kthx().gcs.names(kthx().bucket, `${site.name}/art`)).toEqual([]);

    const listed = await get(site, '/api/files').then((r) => r.json());
    expect(listed.items).toMatchObject([
      {
        path: 'art/cover.png',
        url: `https://${site.host}/files/art/cover.png`,
        size: PNG.byteLength,
        type: 'image/png',
      },
    ]);

    const inspected = await kthx()
      .fetch(ask(`/api/sites/${site.name}`, { token: site.token }))
      .then((r) => r.json());
    expect(inspected.usage.files_bytes).toBe(PNG.byteLength);
    expect(inspected.quotas.file_bytes).toBe(MAX_FILE_BYTES);
    expect(inspected.quotas.files_bytes).toBe(MAX_FILES_BYTES);
  });

  test('reads through the depot, and a row with no bytes is a 404', async () => {
    const site = await claimed('depot');
    expect(
      (await put(site, 'notes.txt', 'hello', { type: 'text/plain' })).status,
    ).toBe(201);

    const object = join(kthx().depotDir, 'files', site.name, 'notes.txt');
    expect(await Bun.file(object).text()).toBe('hello');
    const served = await get(site, '/files/notes.txt');
    expect(served.status).toBe(200);
    expect(served.headers.get('content-length')).toBe('5');
    expect(await served.text()).toBe('hello');

    await rm(object);
    expect((await get(site, '/files/notes.txt')).status).toBe(404);
  });

  test('answers 304 to a matching etag, and HEAD without a body', async () => {
    const site = await claimed('etag');
    await put(site, 'a.txt', 'one', { type: 'text/plain' });
    const first = await get(site, '/files/a.txt');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const again = await get(site, '/files/a.txt', {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);

    const head = await get(site, '/files/a.txt', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('3');
    expect(await head.text()).toBe('');

    await put(site, 'a.txt', 'two!', {
      type: 'text/plain',
      token: site.token,
    });
    const changed = await get(site, '/files/a.txt', {
      headers: { 'if-none-match': etag },
    });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe('two!');
  });

  test('is nothing when there is no row', async () => {
    const site = await claimed('missing');
    const missing = await get(site, '/files/nope.png');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('NOT_FOUND');
  });
});

describe('the content-type allowlist', () => {
  test('refuses everything that is a document on this origin', async () => {
    const site = await claimed('types');
    for (const type of [
      'text/html',
      'image/svg+xml',
      'image/svg',
      'image/svg+xml.',
      'application/xhtml+xml',
      'text/javascript',
      'application/javascript',
      'application/xml',
      'text/xml',
      'application/octet-stream',
      'font/woff2',
    ]) {
      const refused = await put(site, 'x.bin', 'body', { type });
      expect([type, refused.status]).toEqual([type, 400]);
      expect((await refused.json()).code).toBe('UNSUPPORTED_TYPE');
    }
    // Nothing sniffs, so a missing type is refused.
    const bare = await put(site, 'x.bin', 'body');
    expect(bare.status).toBe(400);
    expect((await bare.json()).code).toBe('UNSUPPORTED_TYPE');
  });

  test('takes the media types a browser renders, parameters and case aside', async () => {
    const site = await claimed('taken');
    for (const type of [
      'image/png',
      'audio/mpeg',
      'video/mp4',
      'application/pdf',
      'application/json',
      'text/plain',
      'text/csv',
      'text/markdown',
    ]) {
      const stored = await put(site, `f-${type.replace('/', '-')}`, 'b', {
        type,
      });
      expect([type, stored.status]).toEqual([type, 201]);
      expect((await stored.json()).type).toBe(type);
    }
    const normalised = await put(site, 'shout.txt', 'b', {
      type: 'TEXT/Plain; charset=UTF-8',
    });
    expect((await normalised.json()).type).toBe('text/plain');
  });

  test('hands over anything not meant to be rendered as an attachment', async () => {
    const site = await claimed('disposition');
    await put(site, 'data.json', '{"a":1}', { type: 'application/json' });
    const json = await get(site, '/files/data.json');
    expect(json.headers.get('content-disposition')).toBe(
      'attachment; filename="data.json"',
    );
    expect(json.headers.get('content-type')).toBe('application/json');

    await put(site, 'read.md', '# hi', { type: 'text/markdown' });
    const markdown = await get(site, '/files/read.md');
    expect(markdown.headers.get('content-disposition')).toBe('inline');
    expect(markdown.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    );
  });
});

describe('the ownership floor', () => {
  test('lets anyone create, and only the creator or the owner overwrite', async () => {
    const site = await claimed('owned');
    const alice: Visitor = {};
    const bob: Visitor = {};

    expect(
      (
        await put(site, 'shared.txt', 'alice', {
          type: 'text/plain',
          as: alice,
        })
      ).status,
    ).toBe(201);
    expect(alice.cookie).toContain(ME_COOKIE);

    expect(
      (
        await put(site, 'bob.txt', 'bob', {
          type: 'text/plain',
          as: bob,
        })
      ).status,
    ).toBe(201);

    const stolen = await put(site, 'shared.txt', 'bob was here', {
      type: 'text/plain',
      as: bob,
    });
    expect(stolen.status).toBe(403);
    expect(await get(site, '/files/shared.txt').then((r) => r.text())).toBe(
      'alice',
    );

    const deleted = await kthx().fetch(
      ask('/api/files/shared.txt', {
        host: site.host,
        method: 'DELETE',
        headers: { cookie: bob.cookie ?? '' },
        address: address(),
      }),
    );
    expect(deleted.status).toBe(403);

    const again = await put(site, 'shared.txt', 'alice again', {
      type: 'text/plain',
      as: alice,
    });
    expect(again.status).toBe(200);

    const byOwner = await put(site, 'shared.txt', 'the owner', {
      type: 'text/plain',
      token: site.token,
    });
    expect(byOwner.status).toBe(200);
    // The path keeps its creator, not whoever wrote last.
    const [row] = (await kthx().sql`
      select owner from files where site = ${site.name} and path = 'shared.txt'
    `) as { owner: string }[];
    expect(row?.owner).toBe((alice.cookie ?? '').split('=')[1]?.split('.')[0]);
  });

  test('deletes to the owner, and says nothing when there is nothing', async () => {
    const site = await claimed('delete');
    const alice: Visitor = {};
    await put(site, 'gone.txt', 'bytes', { type: 'text/plain', as: alice });
    const object = join(kthx().depotDir, 'files', site.name, 'gone.txt');
    expect(await Bun.file(object).exists()).toBe(true);

    const removed = await kthx().fetch(
      ask('/api/files/gone.txt', {
        host: site.host,
        method: 'DELETE',
        headers: { cookie: alice.cookie ?? '' },
        address: address(),
      }),
    );
    expect(removed.status).toBe(204);
    expect((await get(site, '/files/gone.txt')).status).toBe(404);
    expect(await Bun.file(object).exists()).toBe(false);

    const twice = await kthx().fetch(
      ask('/api/files/gone.txt', {
        host: site.host,
        method: 'DELETE',
        headers: { cookie: alice.cookie ?? '' },
        address: address(),
      }),
    );
    expect(twice.status).toBe(204);
  });
});

describe('the paths a file may have', () => {
  test('refuses traversal, dotfiles and everything outside the charset', async () => {
    const site = await claimed('paths');
    for (const path of [
      '.env',
      'a/.git/config',
      'a//b',
      'a b.txt',
      'sp%C3%A4ce/../../x',
      `${'a'.repeat(300)}.txt`,
    ]) {
      const refused = await put(site, path, 'b', { type: 'text/plain' });
      expect([path, refused.status >= 400]).toEqual([path, true]);
      expect([path, refused.status]).not.toEqual([path, 201]);
    }
    const rows = (await kthx().sql`
      select count(*)::int as n from files where site = ${site.name}
    `) as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });

  test('cannot address a file outside the store', async () => {
    const site = await claimed('escape');
    // Raw, the URL parser resolves the segments away; percent-encoded, they
    // arrive and are refused.
    for (const path of ['../../etc/passwd', '%2e%2e%2f%2e%2e%2fpasswd']) {
      const escaped = await put(site, path, 'root', { type: 'text/plain' });
      expect([path, escaped.status]).not.toEqual([path, 201]);
    }
    const rows = (await kthx().sql`
      select count(*)::int as n from files where site = ${site.name}
    `) as { n: number }[];
    expect(rows[0]?.n).toBe(0);
    expect(await Bun.file(join(kthx().depotDir, 'etc/passwd')).exists()).toBe(
      false,
    );
  });
});

describe('the budget', () => {
  test('refuses a body over the per-file ceiling before it is read', async () => {
    const site = await claimed('big');
    const refused = await kthx().fetch(
      ask('/api/files/huge.bin', {
        host: site.host,
        method: 'PUT',
        headers: {
          'content-type': 'image/png',
          'content-length': String(MAX_FILE_BYTES + 1),
        },
        body: 'not really that big',
        address: address(),
      }),
    );
    expect(refused.status).toBe(413);
    expect((await refused.json()).code).toBe('TOO_LARGE');
  });

  test('refuses a file past the site ceiling and past the file count', async () => {
    const site = await claimed('full');
    await kthx().sql`insert into sites (name) values (${site.name})`;
    // The rows are the meter, so a row reaches the ceiling without an upload.
    await kthx().sql`
      insert into files (site, path, owner, size, type, sha256)
      values (${site.name}, 'ballast.bin', 'someone', ${MAX_FILES_BYTES},
              'image/png', 'x')
    `;
    const full = await put(site, 'one-more.png', PNG, { type: 'image/png' });
    expect(full.status).toBe(507);
    expect((await full.json()).code).toBe('SITE_FULL');

    await kthx().sql`delete from files where site = ${site.name}`;
    await kthx().sql`
      insert into files (site, path, owner, size, type, sha256)
      select ${site.name}, 'f' || n, 'someone', 1, 'image/png', 'x'
      from generate_series(1, ${MAX_FILES}) as n
    `;
    const counted = await put(site, 'one-more.png', PNG, { type: 'image/png' });
    expect(counted.status).toBe(507);

    // An overwrite is not a new file, so the count does not refuse it.
    const overwrite = await put(site, 'f1', PNG, {
      type: 'image/png',
      token: site.token,
    });
    expect(overwrite.status).toBe(200);
  });
});

describe("a site's whole store", () => {
  test('goes when the site does', async () => {
    const site = await claimed('deleted');
    await put(site, 'keep.txt', 'bytes', { type: 'text/plain' });
    const object = join(kthx().depotDir, 'files', site.name, 'keep.txt');
    expect(await Bun.file(object).exists()).toBe(true);

    const removed = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );
    expect(removed.status).toBe(204);

    const rows = (await kthx().sql`
      select count(*)::int as n from files where site = ${site.name}
    `) as { n: number }[];
    expect(rows[0]?.n).toBe(0);
    expect(await Bun.file(object).exists()).toBe(false);

    const gone = await get(site, '/files/keep.txt');
    expect(gone.status).toBe(404);
  });

  test('needs no site database', async () => {
    const site = await claimed('unprovisioned');
    await put(site, 'early.txt', 'bytes', { type: 'text/plain' });
    // Files live in the control database, so a site that never asked for its
    // own database has none.
    const [row] = (await kthx().sql`
      select provisioned_at from sites where name = ${site.name}
    `) as { provisioned_at: Date | null }[];
    expect(row?.provisioned_at).toBeNull();
    const served = await get(site, '/files/early.txt');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('bytes');
  });
});

describe('the reserved prefix', () => {
  test("is the server's on every site, never a file in the folder", async () => {
    const site = await claimed('reserved');
    // nginx forwards `/files/*` here, so a deployed `files/` is unreachable.
    kthx().gcs.put(
      kthx().bucket,
      `${site.name}/files/sneaky.html`,
      '<script>1</script>',
      {
        contentType: 'text/html',
      },
    );
    const sneaky = await get(site, '/files/sneaky.html');
    expect(sneaky.status).toBe(404);
    expect(sneaky.headers.get('content-type')).toContain('application/json');
  });
});

describe('the bounds a body meets', () => {
  test('refuses more than the cap without holding it, and gives up on a stall', async () => {
    // A chunked body has no `content-length`, so only the reader stands
    // between an anonymous caller and the server-wide 32 MiB.
    let cancelled = false;
    const trickle = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
      cancel() {
        cancelled = true;
      },
    });
    const over = await bodyWithin(
      new Request('http://x/', { method: 'PUT', body: trickle }),
      60_000,
      256,
    );
    expect(over).toBeNull();
    expect(cancelled).toBe(true);

    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    await expect(
      bodyWithin(
        new Request('http://x/', { method: 'PUT', body: stalled }),
        20,
        1024,
      ),
    ).rejects.toThrow(/did not arrive in time/);
  });

  test('takes eight bodies at once and refuses the ninth', async () => {
    const site = await claimed('inflight');
    const gates: (() => void)[] = [];
    const held = Array.from({ length: 8 }, (_unused, n) =>
      kthx().fetch(
        ask(`/api/files/held-${n}.png`, {
          host: site.host,
          method: 'PUT',
          headers: { 'content-type': 'image/png' },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PNG);
            },
            pull(controller) {
              return new Promise<void>((resolve) => {
                gates.push(() => {
                  controller.close();
                  resolve();
                });
              });
            },
          }),
          address: address(),
        }),
      ),
    );
    // Wait until all eight bodies are arriving and holding their slots.
    for (let waited = 0; gates.length < 8 && waited < 2000; waited += 1) {
      await Bun.sleep(1);
    }
    expect(gates).toHaveLength(8);

    const ninth = await put(site, 'ninth.png', PNG, { type: 'image/png' });
    expect(ninth.status).toBe(503);
    expect((await ninth.json()).code).toBe('BUSY');

    for (const open of gates) open();
    expect(
      (await Promise.all(held)).map((response) => response.status),
    ).toEqual(Array.from({ length: 8 }, () => 201));
  });

  test('is not something a foreign page may write', async () => {
    const site = await claimed('foreign');
    const refused = await kthx().fetch(
      ask('/api/files/theirs.png', {
        host: site.host,
        method: 'PUT',
        headers: {
          'content-type': 'image/png',
          origin: 'https://evil.example',
        },
        body: PNG,
        address: address(),
      }),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('FORBIDDEN');
  });
});

describe('a depot write that fails', () => {
  test('leaves the row it could not replace describing the bytes still there', async () => {
    const site = await claimed('rollback');
    const visitor: Visitor = {};
    await put(site, 'one.txt', 'ORIGINAL', { type: 'text/plain', as: visitor });
    const [before] = (await kthx().sql`
      select size, sha256 from files where site = ${site.name}
    `) as { size: string; sha256: string }[];

    // A directory now sits where the object goes, so the depot write fails.
    const object = join(kthx().depotDir, 'files', site.name, 'one.txt');
    await rm(object);
    await mkdir(object);
    const failed = await put(site, 'one.txt', 'REPLACED', {
      type: 'text/plain',
      as: visitor,
    });
    expect(failed.status).toBe(500);

    const [after] = (await kthx().sql`
      select size, sha256 from files where site = ${site.name}
    `) as { size: string; sha256: string }[];
    expect(after).toEqual(before as { size: string; sha256: string });
  });
});
