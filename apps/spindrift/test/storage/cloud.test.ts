import { describe, expect, test } from 'bun:test';
import { uploadToGcsBucket } from '@repo/archive/gcs';
import { testBucketPermissions } from '../../src/commands/storage/test-bucket.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { testGcsBucketPermissions } from '../../src/storage/cloud.ts';

describe('cloud storage WIF permissions and publishing', () => {
  const mockFederation = {
    audience:
      '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/prov',
    tokenUrl: 'http://localhost-fake/token',
    tokenPath: '/tmp/fake-token',
    impersonationUrl: null,
  };

  test('testBucketPermissions fails gracefully when manifest has no WIF federation', async () => {
    const context = {
      manifest: {
        cloud: { federation: null },
      },
    } as unknown as CommandContext;

    const result = await testBucketPermissions(
      { bucketName: 'my-bucket' },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('NOT_DEPLOYABLE');
      expect(result.failure.message).toContain('Workload Identity Federation');
    }
  });

  test('testGcsBucketPermissions performs GCS API check with WIF token', async () => {
    const mockFetch = async (input: RequestInfo | URL) => {
      const urlStr = input instanceof Request ? input.url : input.toString();
      if (urlStr.includes('token')) {
        return new Response(
          JSON.stringify({
            access_token: 'fake-access-token',
            expires_in: 3600,
          }),
        );
      }
      if (urlStr.includes('storage.googleapis.com/storage/v1/b/test-bucket')) {
        return new Response(
          JSON.stringify({ kind: 'storage#bucket', name: 'test-bucket' }),
          { status: 200 },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const result = await testGcsBucketPermissions({
      bucketName: 'test-bucket',
      federation: {
        ...mockFederation,
        fetch: mockFetch,
        readToken: async () => 'projected-jwt-token',
      },
    });

    expect(result.accessible).toBe(true);
    expect(result.bucketName).toBe('test-bucket');
    expect(result.location).toBe('gs://test-bucket');
  });

  test('uploadToGcsBucket uploads bytes directly to GCS via WIF token', async () => {
    let uploadedBytes: Uint8Array | null = null;
    let authHeader: string | null = null;

    const mockFetch = async (input: RequestInfo | URL) => {
      const req =
        input instanceof Request ? input : new Request(input.toString());
      const urlStr = req.url;
      if (urlStr.includes('token')) {
        return new Response(
          JSON.stringify({
            access_token: 'fake-gcs-token',
            expires_in: 3600,
          }),
        );
      }
      if (
        urlStr.includes(
          'storage.googleapis.com/upload/storage/v1/b/my-artifacts/o',
        )
      ) {
        authHeader = req.headers.get('Authorization');
        uploadedBytes = new Uint8Array(await req.arrayBuffer());
        return new Response(
          JSON.stringify({ kind: 'storage#object', name: 'archive.zip' }),
          { status: 200 },
        );
      }
      return new Response('error', { status: 500 });
    };

    const payload = new TextEncoder().encode('gcs test archive content');
    const result = await uploadToGcsBucket({
      bucketName: 'my-artifacts',
      objectName: 'archive.zip',
      bytes: payload,
      federation: {
        ...mockFederation,
        fetch: mockFetch,
        readToken: async () => 'projected-jwt-token',
      },
    });

    expect(result.location).toBe('gs://my-artifacts/archive.zip');
    expect(result.size).toBe(payload.byteLength);
    expect(authHeader as string | null).not.toBeNull();
    expect(authHeader!).toBe('Bearer fake-gcs-token');
    expect(uploadedBytes).not.toBeNull();
    expect(new TextDecoder().decode(uploadedBytes!)).toBe(
      'gcs test archive content',
    );
  });
});
