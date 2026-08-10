import { describe, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Principal } from '../../src/commands/types.ts';
import { sniffArchiveFormat } from '../../src/storage/archive-format.ts';
import { readStagedArchive } from '../../src/storage/archives.ts';
import type { DispatchDeps } from '../../src/web/dispatch.ts';
import { handleUpload } from '../../src/web/upload.ts';
import { zipOf } from '../fixtures/zip.ts';

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

  test('stages a gzipped tar exactly as it arrived', async () => {
    const payload = new Uint8Array(gzipSync(new TextEncoder().encode('tar')));
    const request = new Request('http://localhost/internal/upload', {
      method: 'POST',
      headers: {
        'x-filename': 'test-app.tar.gz',
      },
      body: payload,
    });

    const response = await handleUpload(request, deps(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.value.filename).toBe('test-app.tar.gz');
    expect(body.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(body.value.location).toMatch(/^upload:\/\/[0-9a-f]{64}$/);
    expect(body.value.size).toBe(payload.byteLength);

    // Byte-for-byte, because the format was already the one every route opens
    // and a needless re-pack would change the digest of an unchanged upload.
    const staged = await readStagedArchive(body.value.digest);
    expect(staged).not.toBeNull();
    expect(Buffer.from(staged!).equals(Buffer.from(payload))).toBe(true);
  });

  test('stages a ZIP as the gzipped tar every build route can open', async () => {
    const formData = new FormData();
    formData.append(
      'file',
      new File([zipOf([{ path: 'index.html', text: 'hi' }])], 'sample.zip', {
        type: 'application/zip',
      }),
    );

    const request = new Request('http://localhost/internal/upload', {
      method: 'POST',
      body: formData,
    });

    const response = await handleUpload(request, deps(true));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    // Renamed, because the staged object is no longer a ZIP and the depot names
    // it by this extension.
    expect(body.value.filename).toBe('sample.tar.gz');

    const staged = await readStagedArchive(body.value.digest);
    expect(staged).not.toBeNull();
    expect(sniffArchiveFormat(staged!)).toBe('gzip');
    // The digest names what is in the depot, not what was uploaded — the build
    // hull re-checks it with `sha256sum` before it extracts.
    expect(body.value.size).toBe(staged!.byteLength);
    expect(new TextDecoder().decode(gunzipSync(staged!))).toContain(
      'index.html',
    );
  });

  test('refuses bytes no build route could open, at the boundary', async () => {
    // The whole defect in one request: a file named `.zip` that is not one.
    // This used to stage, sign, dispatch, and fail inside a runner as
    // ARTIFACT_UNAVAILABLE.
    const request = new Request('http://localhost/internal/upload', {
      method: 'POST',
      headers: { 'x-filename': 'site.zip' },
      body: new TextEncoder().encode('<!doctype html>not an archive'),
    });

    const response = await handleUpload(request, deps(true));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.failure.code).toBe('UNKNOWN_FORMAT');
    expect(body.failure.message).toContain('gzipped tar');
  });
});
