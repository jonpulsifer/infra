import { describe, expect, test } from 'bun:test';
import type { Principal } from '../../src/commands/types.ts';
import { readStagedArchive } from '../../src/storage/archives.ts';
import type { DispatchDeps } from '../../src/web/dispatch.ts';
import { handleUpload } from '../../src/web/upload.ts';

const mockPrincipal: Principal = {
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'Operator',
};

function deps(authenticated = true): DispatchDeps {
  return {
    async authenticate() {
      return authenticated
        ? { kind: 'authenticated', principal: mockPrincipal }
        : { kind: 'anonymous' };
    },
    context(_principal) {
      return {} as any;
    },
  };
}

describe('archive upload endpoint', () => {
  test('refuses unauthenticated upload requests with 401', async () => {
    const request = new Request('http://localhost/internal/upload', {
      method: 'POST',
      body: new Uint8Array([1, 2, 3]),
    });
    const response = await handleUpload(request, deps(false));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.failure.code).toBe('UNAUTHENTICATED');
  });

  test('stages raw binary upload bytes durably and returns digest and location', async () => {
    const payload = new TextEncoder().encode('dummy zip file contents');
    const request = new Request('http://localhost/internal/upload', {
      method: 'POST',
      headers: {
        'x-filename': 'test-app.zip',
      },
      body: payload,
    });

    const response = await handleUpload(request, deps(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.value.filename).toBe('test-app.zip');
    expect(body.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.value.location).toMatch(/^upload:\/\/[0-9a-f]{64}$/);
    expect(body.value.size).toBe(payload.byteLength);

    const staged = await readStagedArchive(body.value.digest);
    expect(staged).not.toBeNull();
    expect(new TextDecoder().decode(staged!)).toBe('dummy zip file contents');
  });

  test('stages multipart/form-data upload file durably', async () => {
    const fileContent = 'multipart archive content';
    const formData = new FormData();
    formData.append(
      'file',
      new File([fileContent], 'sample.tar.gz', { type: 'application/gzip' }),
    );

    const request = new Request('http://localhost/internal/upload', {
      method: 'POST',
      body: formData,
    });

    const response = await handleUpload(request, deps(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.value.filename).toBe('sample.tar.gz');
    expect(body.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const staged = await readStagedArchive(body.value.digest);
    expect(staged).not.toBeNull();
    expect(new TextDecoder().decode(staged!)).toBe('multipart archive content');
  });
});
