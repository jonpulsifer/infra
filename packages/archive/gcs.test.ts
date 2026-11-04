import { afterAll, describe, expect, test } from 'bun:test';
import { crc32c, crc32cValue } from './crc32c.ts';
import { fakeGcs } from './fake-gcs.ts';
import { FederationError } from './federation.ts';
import {
  deleteGcsPrefix,
  isPreconditionFailure,
  listGcsObjects,
  patchGcsMetadata,
  readGcsBytes,
  readGcsObject,
  statGcsObject,
  writeGcsObject,
} from './gcs.ts';

const federation = {
  audience:
    '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov',
  tokenUrl: 'http://localhost-fake/token',
  tokenPath: '/tmp/fake-token',
  impersonationUrl: null,
  readToken: async () => 'projectedjwt',
};

/** Answers the token exchange, and every other request with `object`. */
const farSide = (object: (request: Request) => Response) => {
  const requests: Request[] = [];
  const fetcher = async (request: Request) => {
    if (request.url.includes('/token')) {
      return new Response(
        JSON.stringify({ access_token: 'faketoken', expires_in: 3600 }),
      );
    }
    requests.push(request);
    return object(request);
  };
  return { requests, fetcher };
};

describe('readGcsObject', () => {
  test('streams the bytes of an object, addressed as one escaped segment', async () => {
    const { requests, fetcher } = farSide(() => new Response('release bytes'));

    const stream = await readGcsObject({
      bucketName: 'depot',
      objectName: 'ephemeral/abc.tgz',
      federation: { ...federation, fetch: fetcher },
    });

    expect(stream).not.toBeNull();
    expect(await new Response(stream).text()).toBe('release bytes');
    expect(requests[0]?.url).toBe(
      'https://storage.googleapis.com/storage/v1/b/depot/o/ephemeral%2Fabc.tgz?alt=media',
    );
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer faketoken');
  });

  test('an object the depot no longer holds is null rather than a throw', async () => {
    const { fetcher } = farSide(() => new Response('', { status: 404 }));

    expect(
      await readGcsObject({
        bucketName: 'depot',
        objectName: 'gone.tgz',
        federation: { ...federation, fetch: fetcher },
      }),
    ).toBeNull();
  });

  test("an object over the caller's ceiling is refused unread", async () => {
    const { fetcher } = farSide(
      () =>
        new Response('too many bytes', {
          headers: { 'content-length': '9000' },
        }),
    );

    await expect(
      readGcsObject({
        bucketName: 'depot',
        objectName: 'huge.tgz',
        federation: { ...federation, fetch: fetcher },
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(FederationError);
  });

  test('a refusal is not absence', async () => {
    const { fetcher } = farSide(() => new Response('no', { status: 403 }));

    await expect(
      readGcsObject({
        bucketName: 'depot',
        objectName: 'forbidden.tgz',
        federation: { ...federation, fetch: fetcher },
      }),
    ).rejects.toBeInstanceOf(FederationError);
  });
});

describe('the bucket API against a fake', () => {
  const fake = fakeGcs();
  const auth = { token: () => 'tok', endpoint: fake.url };
  const bucketName = 'sites';
  const bytesOf = (text: string) => new TextEncoder().encode(text);
  afterAll(() => fake.stop());

  test('lists every page, with checksums and metadata', async () => {
    for (let n = 0; n < 5; n += 1) {
      fake.put(bucketName, `paged/${n}.txt`, `body ${n}`, {
        metadata: { n: String(n) },
      });
    }
    const listed = await listGcsObjects({
      bucketName,
      auth: { ...auth, fetch: pagesOf(2) },
      prefix: 'paged/',
    });
    expect(listed.map((object) => object.name)).toEqual([
      'paged/0.txt',
      'paged/1.txt',
      'paged/2.txt',
      'paged/3.txt',
      'paged/4.txt',
    ]);
    expect(listed[3]?.metadata).toEqual({ n: '3' });
    expect(listed[3]?.crc32c).toBe(crc32c(bytesOf('body 3')));
  });

  test('a glob lists only the names it matches', async () => {
    fake.put(bucketName, 'one/.kthx', '{}');
    fake.put(bucketName, 'one/index.html', 'hi');
    fake.put(bucketName, 'two/deep/.kthx', '{}');
    const markers = await listGcsObjects({
      bucketName,
      auth,
      matchGlob: '*/.kthx',
    });
    expect(markers.map((object) => object.name)).toEqual(['one/.kthx']);
  });

  test('a write with generation 0 loses to an object already there', async () => {
    const write = (ifGenerationMatch: string | number) =>
      writeGcsObject({
        bucketName,
        objectName: 'race/.kthx',
        bytes: bytesOf('{}'),
        contentType: 'application/json',
        metadata: { 'kthx-owner': 'a@example.com' },
        ifGenerationMatch,
        auth,
      });
    const first = await write(0);
    expect(first.metadata['kthx-owner']).toBe('a@example.com');
    expect(isPreconditionFailure(await write(0).catch((e) => e))).toBe(true);
    expect(isPreconditionFailure(await write('1').catch((e) => e))).toBe(true);
    const current = await write(first.generation);
    expect(current.generation).not.toBe(first.generation);
  });

  test('a write carries its type, cache policy and bytes', async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 13, 10]);
    await writeGcsObject({
      bucketName,
      objectName: 'typed/a.bin',
      bytes,
      contentType: 'image/png',
      cacheControl: 'no-cache',
      auth,
    });
    const stored = fake.get(bucketName, 'typed/a.bin');
    expect(stored?.contentType).toBe('image/png');
    expect(stored?.cacheControl).toBe('no-cache');
    expect([...(stored?.bytes ?? [])]).toEqual([...bytes]);
    const read = await readGcsBytes({
      bucketName,
      objectName: 'typed/a.bin',
      auth,
      maxBytes: 100,
    });
    expect([...(read ?? [])]).toEqual([...bytes]);
  });

  test('metadata merges without a new generation', async () => {
    const written = fake.put(bucketName, 'meta/.kthx', '{}', {
      metadata: { 'kthx-owner': 'a@example.com' },
    });
    const patched = await patchGcsMetadata({
      bucketName,
      objectName: 'meta/.kthx',
      metadata: { 'kthx-deployed': '2026-11-01T00:00:00.000Z' },
      auth,
    });
    expect(patched.generation).toBe(String(written.generation));
    expect(patched.metadata).toEqual({
      'kthx-owner': 'a@example.com',
      'kthx-deployed': '2026-11-01T00:00:00.000Z',
    });
  });

  test('stat answers null for a missing object', async () => {
    expect(
      await statGcsObject({ bucketName, objectName: 'nope/.kthx', auth }),
    ).toBeNull();
  });

  test('a prefix is deleted with its last object deleted last', async () => {
    fake.put(bucketName, 'gone/.kthx', '{}');
    fake.put(bucketName, 'gone/a.css', 'a');
    fake.put(bucketName, 'gone/index.html', 'b');
    fake.put(bucketName, 'gonefishing/.kthx', '{}');
    const before = fake.calls.length;
    const count = await deleteGcsPrefix({
      bucketName,
      auth,
      prefix: 'gone/',
      last: 'gone/.kthx',
    });
    expect(count).toBe(3);
    const deletes = fake.calls
      .slice(before)
      .filter((call) => call.kind === 'delete')
      .map((call) => call.name);
    expect(deletes.at(-1)).toBe('gone/.kthx');
    expect(fake.names(bucketName, 'gone')).toEqual(['gonefishing/.kthx']);
  });
});

/** Forces small list pages, so pagination is exercised. */
function pagesOf(size: number) {
  return (request: Request) => {
    const url = new URL(request.url);
    if (url.searchParams.has('maxResults')) {
      url.searchParams.set('maxResults', String(size));
    }
    return fetch(new Request(url, request));
  };
}

describe('crc32c', () => {
  test('matches the published check value', () => {
    expect(crc32cValue(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array())).toBe('AAAAAA==');
  });
});
