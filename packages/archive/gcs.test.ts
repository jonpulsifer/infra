import { describe, expect, test } from 'bun:test';
import { FederationError } from './federation.ts';
import { readGcsObject } from './gcs.ts';

const federation = {
  audience:
    '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov',
  tokenUrl: 'http://localhost-fake/token',
  tokenPath: '/tmp/fake-token',
  impersonationUrl: null,
  readToken: async () => 'projectedjwt',
};

/** The token exchange, then whatever the object read should answer. */
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
